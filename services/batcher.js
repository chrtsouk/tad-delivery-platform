/**
 * tad-batcher — the dispatch brain.
 *
 * On Ready: cluster ready delivery orders by postcode district (merging districts that are close), let our own VROOM
 * sequence and split them (capacity = max stops per driver), cut a run wherever the drive between two drops is longer than
 * the owner's limit, then give each ripe run to an available driver by the chosen strategy.
 *
 *  - ripe        a run is sent when it is full, or its oldest order has waited `batch_hold_minutes`, or the admin presses "send now".
 *  - queue       no driver free and nobody out? orders just stay Ready; the next clock-in / return picks them up.
 *  - pre-assign  every driver is out? nearby orders accumulate on the driver due back soonest, for his NEXT run.
 *  - override    the admin can move an order to another driver, or back to the queue, at any time before it is out.
 *  - return push when an out driver is `return_push_minutes` from the store and has a next run waiting, tell him to collect it.
 */
import { q, tx } from '../lib/db.js';
import { AppError } from '../lib/util.js';
import { haversineKm, centroid } from '../lib/geo.js';
import { nnSequence, estimateSeconds } from '../lib/route.js';

export function createBatcher(ctx) {
  const { db, now, settings, orders, shifts, vroom, osrm, fleetbase, audit, bus, notify, logger = console } = ctx;
  const iso = () => now().toISOString();
  const minutes = (n) => n * 60000;

  /* ------------------------------------------------------------ clustering */

  /** Group by outcode, then merge groups whose centres are within cluster_merge_km. Oldest-ready group first. */
  function cluster(readyOrders, s) {
    const byOut = new Map();
    for (const o of readyOrders) { const k = o.outcode || 'NA'; (byOut.get(k) ?? byOut.set(k, []).get(k)).push(o); }
    let groups = [...byOut.values()];
    for (let merged = true; merged;) {
      merged = false;
      outer: for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
        if (haversineKm(centroid(groups[i]), centroid(groups[j])) <= s.cluster_merge_km) {
          groups[i] = groups[i].concat(groups[j]); groups.splice(j, 1); merged = true; break outer;
        }
      }
    }
    const oldest = (g) => Math.min(...g.map((o) => Date.parse(o.ready_at || o.created_at)));
    return groups.sort((a, b) => oldest(a) - oldest(b));
  }

  /** Sequence one cluster into runs of at most max_tasks. Uses VROOM; falls back to nearest-neighbour if it is unreachable. */
  async function sequence(group, s, store) {
    const k = Math.ceil(group.length / s.max_tasks);
    const svc = s.service_minutes_per_drop * 60;
    try {
      const vehicles = Array.from({ length: k }, (_, i) => ({ id: i + 1, start: store, capacity: s.max_tasks, max_tasks: s.max_tasks }));
      const sol = await vroom.solve({ vehicles, jobs: group.map((o) => ({ id: o.id, loc: o, service: svc })) });
      const map = new Map(group.map((o) => [o.id, o]));
      const runs = sol.routes.map((r) => ({
        orders: r.stops.map((st) => map.get(st.job)),
        legs: r.stops.map((st, i) => (i === 0 ? null : st.arrival - r.stops[i - 1].arrival - svc)),
      })).filter((r) => r.orders.length);
      for (const id of sol.unassigned) runs.push({ orders: [map.get(id)], legs: [null] });
      return { runs, engine: 'vroom' };
    } catch (e) {
      logger.warn?.(`VROOM unavailable (${e.message}); sequencing locally`);
      const runs = [];
      let rest = [...group];
      while (rest.length) {
        const seed = rest.sort((a, b) => haversineKm(store, a) - haversineKm(store, b))[0];
        const near = rest.filter((o) => o !== seed).sort((a, b) => haversineKm(seed, a) - haversineKm(seed, b)).slice(0, s.max_tasks - 1);
        const chosen = nnSequence(store, [seed, ...near]);
        runs.push({ orders: chosen, legs: chosen.map((o, i) => (i === 0 ? null : estimateSeconds(chosen[i - 1], o))) });
        rest = rest.filter((o) => !chosen.includes(o));
      }
      return { runs, engine: 'local' };
    }
  }

  /** Cut a run where the drive between two drops is longer than max_gap_minutes. */
  function splitByGap(run, s) {
    const limit = s.max_gap_minutes * 60, pieces = [];
    let cur = [];
    run.orders.forEach((o, i) => {
      if (i > 0 && run.legs[i] != null && run.legs[i] > limit) { pieces.push(cur); cur = []; }
      cur.push(o);
    });
    if (cur.length) pieces.push(cur);
    return pieces;
  }

  /* ------------------------------------------------------------- the plan */

  /** What the batcher WOULD do right now (also drives the board's batch preview). Pure: writes nothing. */
  async function plan({ sendNow = false, only = null } = {}) {
    const s = settings.all();
    let ready = orders.list({ states: ['ready'] }).filter((o) => o.fulfilment === 'delivery' && o.lat != null);
    if (only) ready = ready.filter((o) => only.includes(o.id));
    const proposals = [];
    let engine = 'none';
    const sites = [...new Set(ready.map((o) => o.site_id))];
    for (const site of sites) for (const group of cluster(ready.filter((o) => o.site_id === site), s)) {
      const seq = await sequence(group, s, ctx.sites.store(site));
      engine = seq.engine;
      for (const run of seq.runs) for (const piece of splitByGap(run, s)) {
        const oldestAge = now().getTime() - Math.min(...piece.map((o) => Date.parse(o.ready_at || o.created_at)));
        const full = piece.length >= s.max_tasks;
        const ripe = sendNow || full || oldestAge >= minutes(s.batch_hold_minutes);
        proposals.push({ site, orders: piece, ripe, full, waits_seconds: ripe ? 0 : Math.ceil((minutes(s.batch_hold_minutes) - oldestAge) / 1000), oldest_at: Math.min(...piece.map((o) => Date.parse(o.ready_at || o.created_at))) });
      }
    }
    proposals.sort((a, b) => a.oldest_at - b.oldest_at);
    return { proposals, engine };
  }

  /* -------------------------------------------------------------- drivers */

  function chooseDriver(strategy, candidates, s, store) {
    if (!candidates.length) return null;
    const lastAssigned = (d) => q.get(db, 'SELECT MAX(assigned_at) AS t FROM batches WHERE driver_id = ?', d.driver_id)?.t ?? '';
    const today = iso().slice(0, 10);
    const load = (d) => q.get(db, "SELECT COUNT(*) AS n FROM orders WHERE driver_id = ? AND substr(COALESCE(assigned_at, created_at),1,10) = ?", d.driver_id, today).n;
    const idle = (d) => lastAssigned(d);
    const key = {
      nearest: (d) => [d.lat != null ? haversineKm(store, d) : 0, idle(d)],
      round_robin: (d) => [idle(d), 0],
      fewest_jobs: (d) => [load(d), idle(d)],
    }[strategy] ?? ((d) => [0, idle(d)]);
    return [...candidates].sort((a, b) => { const ka = key(a), kb = key(b); return ka[0] < kb[0] ? -1 : ka[0] > kb[0] ? 1 : ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0; })[0];
  }

  /* --------------------------------------------------------------- commit */

  async function dispatchBatchToFleetbase(batchId) {
    const rows = q.all(db, 'SELECT * FROM orders WHERE batch_id = ? ORDER BY stop_seq', batchId);
    const b = q.get(db, 'SELECT * FROM batches WHERE id = ?', batchId);
    for (const o of rows) {
      if (!o.fleetbase_order_id) { try { await orders.syncToFleetbase(orders.byId(o.id)); } catch (e) { logger.warn?.(`Fleetbase order for ${o.number}: ${e.message}`); } }
      const fresh = orders.byId(o.id);
      if (!fresh.fleetbase_order_id) continue;
      try { await fleetbase.assign(fresh.fleetbase_order_id, b.driver_id); await fleetbase.dispatch(fresh.fleetbase_order_id); orders.event(o.id, 'fleetbase_dispatched', { driver: b.driver_id }); }
      catch (e) { orders.event(o.id, 'fleetbase_dispatch_failed', { error: e.message }); logger.warn?.(`Fleetbase dispatch ${o.number}: ${e.message}`); }
    }
  }

  function createBatch(driverId, orderList, { preassigned = false, note = null, status, site = 'main' } = {}) {
    return tx(db, () => {
      const r = q.run(db, 'INSERT INTO batches(site_id, driver_id, status, preassigned, created_at, assigned_at, note) VALUES(?,?,?,?,?,?,?)',
        site, driverId, status ?? (preassigned ? 'planned' : 'assigned'), preassigned ? 1 : 0, iso(), preassigned ? null : iso(), note);
      const id = Number(r.lastInsertRowid);
      orderList.forEach((o, i) => attach(o.id, id, driverId, i + 1, preassigned));
      return id;
    });
  }

  function attach(orderId, batchId, driverId, seq, preassigned) {
    const o = orders.need(orderId);
    if (o.state === 'assigned') q.run(db, 'UPDATE orders SET driver_id = ?, batch_id = ?, stop_seq = ? WHERE id = ?', driverId, batchId, seq, orderId);
    else {
      orders.transition(orderId, 'assigned', { actor: 'batcher', detail: { batch: batchId, driver: driverId, seq, preassigned } });
      q.run(db, 'UPDATE orders SET driver_id = ?, batch_id = ?, stop_seq = ? WHERE id = ?', driverId, batchId, seq, orderId);
    }
  }

  async function activate(batchId) {
    q.run(db, "UPDATE batches SET status = 'assigned', assigned_at = ? WHERE id = ? AND status = 'planned'", iso(), batchId);
    const b = q.get(db, 'SELECT * FROM batches WHERE id = ?', batchId);
    await dispatchBatchToFleetbase(batchId);
    notify.driver(b.driver_id, { kind: 'run_ready', title: 'Your next orders are ready', body: 'Come to the shop, scan the bags and go.', batchId });
    bus.emit('batch', { batchId, status: 'assigned' });
    audit.log('batcher', 'batch.assigned', 'batch', batchId, { driver: b.driver_id });
  }

  /* ----------------------------------------------------------------- tick */

  let chain = Promise.resolve(), running = 0;
  /** One pass of the brain. Calls are queued one after another (a "send now" click never gets lost); `skipIfBusy` is for the timer. */
  function tick(opts = {}) {
    if (opts.skipIfBusy && running) return Promise.resolve({ skipped: true });
    running++;
    const p = chain.then(() => runTick(opts)).finally(() => { running--; });
    chain = p.catch(() => {});
    return p;
  }

  async function runTick({ sendNow = false, only = null } = {}) {
    const out = { assigned: [], preassigned: [], waiting: [], queued: 0, activated: [], returnPushes: 0 };
    {
      orders.releaseScheduled();
      await orders.retryFleetbaseSync();
      out.activated = await activatePreassigned();
      const s = settings.all();
      const { proposals, engine } = await plan({ sendNow, only });
      out.engine = engine;
      const av = await shifts.availability();
      let free = [...av.available];
      const ripe = proposals.filter((p) => p.ripe);
      out.waiting = proposals.filter((p) => !p.ripe).map(summarise);
      for (const p of ripe) {
        const d = chooseDriver(s.strategy, free.filter((x) => x.site_id === p.site), s, ctx.sites.store(p.site));
        if (d) {
          free = free.filter((x) => x.driver_id !== d.driver_id);
          const id = createBatch(d.driver_id, p.orders, { site: p.site, note: engine === 'local' ? 'sequenced locally (VROOM unavailable)' : null });
          await dispatchBatchToFleetbase(id);
          notify.driver(d.driver_id, { kind: 'run_ready', title: `${p.orders.length} order${p.orders.length > 1 ? 's' : ''} ready to collect`, body: 'Scan each bag, then go.', batchId: id });
          audit.log('batcher', 'batch.assigned', 'batch', id, { driver: d.driver_id, orders: p.orders.map((o) => o.number), strategy: s.strategy });
          bus.emit('batch', { batchId: id, status: 'assigned' });
          out.assigned.push({ batch: id, driver: d.driver_id, orders: p.orders.map((o) => o.number) });
          continue;
        }
        const pre = preassign(p, av.busy.filter((b) => b.site_id === p.site), s);
        if (pre) out.preassigned.push(pre); else out.queued += p.orders.length;
      }
      out.returnPushes = await pushReturns();
      return out;
    }
  }

  const summarise = (p) => ({ orders: p.orders.map((o) => ({ id: o.id, number: o.number, postcode: o.postcode })), waits_seconds: p.waits_seconds, full: p.full });

  /** Every driver is out: lay these orders on the driver due back soonest (or add to his waiting next run if it is nearby and has room). */
  function preassign(piece, busy, s) {
    const cand = busy.filter((b) => b.batch_status === 'out');
    if (!cand.length) return null;
    const c = centroid(piece.orders);
    for (const b of cand) {
      const next = q.get(db, "SELECT * FROM batches WHERE driver_id = ? AND status = 'planned' ORDER BY id LIMIT 1", b.driver_id);
      if (!next) continue;
      const rows = q.all(db, 'SELECT * FROM orders WHERE batch_id = ?', next.id);
      if (rows.length + piece.orders.length <= s.max_tasks && haversineKm(centroid(rows), c) <= Math.max(s.cluster_merge_km, 2)) {
        piece.orders.forEach((o, i) => attach(o.id, next.id, b.driver_id, rows.length + i + 1, true));
        audit.log('batcher', 'batch.preassign_extend', 'batch', next.id, { orders: piece.orders.map((o) => o.number) });
        return { batch: next.id, driver: b.driver_id, orders: piece.orders.map((o) => o.number), extended: true };
      }
    }
    const withoutNext = cand.filter((b) => !q.get(db, "SELECT 1 AS x FROM batches WHERE driver_id = ? AND status = 'planned'", b.driver_id));
    const pick = (withoutNext.length ? withoutNext : []).sort((a, b) => (a.return_eta_at || 'z') < (b.return_eta_at || 'z') ? -1 : 1)[0];
    if (!pick) return null;
    const id = createBatch(pick.driver_id, piece.orders, { site: piece.site, preassigned: true, note: 'pre-assigned while the driver is out' });
    audit.log('batcher', 'batch.preassigned', 'batch', id, { driver: pick.driver_id, orders: piece.orders.map((o) => o.number) });
    bus.emit('batch', { batchId: id, status: 'planned' });
    return { batch: id, driver: pick.driver_id, orders: piece.orders.map((o) => o.number) };
  }

  /** A driver who is back (no assigned/out batch) and has a pre-assigned run: turn it into a live run. */
  async function activatePreassigned() {
    const planned = q.all(db, "SELECT * FROM batches WHERE status = 'planned' ORDER BY id");
    const done = [];
    for (const b of planned) {
      const busy = q.get(db, "SELECT 1 AS x FROM batches WHERE driver_id = ? AND status IN ('assigned','out')", b.driver_id);
      const clocked = shifts.open(b.driver_id);
      if (!busy && clocked) { await activate(b.id); done.push(b.id); }
    }
    return done;
  }

  /* ------------------------------------------------------- run life cycle */

  /** Driver scanned the right bags and left the shop. */
  async function markOut(batchId, { actor = 'driver' } = {}) {
    const b = q.get(db, 'SELECT * FROM batches WHERE id = ?', batchId);
    if (!b) throw new AppError('That run does not exist', 404, 'not_found');
    if (b.status !== 'assigned') throw new AppError(`A run that is ${b.status} cannot leave`, 409, 'bad_transition');
    const rows = q.all(db, 'SELECT * FROM orders WHERE batch_id = ? AND state = ?', batchId, 'assigned');
    for (const o of rows) {
      orders.transition(o.id, 'out', { actor });
      if (o.fleetbase_order_id) { try { await fleetbase.start(o.fleetbase_order_id); } catch (e) { logger.warn?.(`Fleetbase start ${o.number}: ${e.message}`); } }
    }
    q.run(db, "UPDATE batches SET status = 'out', out_at = ? WHERE id = ?", iso(), batchId);
    await updateReturnEta(batchId);
    bus.emit('batch', { batchId, status: 'out' });
    audit.log(actor, 'batch.out', 'batch', batchId);
    return q.get(db, 'SELECT * FROM batches WHERE id = ?', batchId);
  }

  /** After each drop: if every order on the run is delivered/failed the run is done, else refresh the ETA home. */
  async function afterDrop(orderId) {
    const o = orders.need(orderId);
    if (!o.batch_id) return null;
    const open = q.get(db, "SELECT COUNT(*) AS n FROM orders WHERE batch_id = ? AND state IN ('assigned','out')", o.batch_id).n;
    if (open === 0) {
      q.run(db, "UPDATE batches SET status = 'done', done_at = ? WHERE id = ?", iso(), o.batch_id);
      await updateReturnEta(o.batch_id, { from: o });
      bus.emit('batch', { batchId: o.batch_id, status: 'done' });
      // the driver is free again the moment he is back: a pre-assigned run can start, queued orders can go
      setImmediate(() => tick().catch((e) => logger.warn?.(e.message)));
    } else await updateReturnEta(o.batch_id, { from: o });
    return o.batch_id;
  }

  async function deliver(orderId, { actor = 'driver', skipFleetbase = false } = {}) {
    const o = orders.need(orderId);
    const done = orders.transition(orderId, o.fulfilment === 'collection' ? 'collected' : 'delivered', { actor });
    if (o.fleetbase_order_id && !skipFleetbase) { try { await fleetbase.complete(o.fleetbase_order_id); } catch (e) { logger.warn?.(`Fleetbase complete ${o.number}: ${e.message}`); } }
    await afterDrop(orderId);
    return done;
  }

  async function fail(orderId, { reason, photo = null, actor = 'driver' }) {
    const done = orders.transition(orderId, 'failed', { reason, photo, actor });
    await afterDrop(orderId);
    return done;
  }

  /** Seconds until the driver is back at the shop: remaining drops in sequence, then home. Written to batches.return_eta_at. */
  async function updateReturnEta(batchId, { from = null } = {}) {
    const s = settings.all();
    const bsite = q.get(db, 'SELECT site_id FROM batches WHERE id = ?', batchId)?.site_id ?? 'main';
    const home = ctx.sites.store(bsite);
    const remaining = q.all(db, "SELECT * FROM orders WHERE batch_id = ? AND state = 'out' ORDER BY stop_seq", batchId);
    const pts = [from && from.lat != null ? from : home, ...remaining, home];
    let secs = 0;
    try { const t = await osrm.table(pts); for (let i = 0; i < pts.length - 1; i++) secs += t[i][i + 1]; }
    catch { for (let i = 0; i < pts.length - 1; i++) secs += estimateSeconds(pts[i], pts[i + 1]); }
    secs += remaining.length * s.service_minutes_per_drop * 60;
    const eta = new Date(now().getTime() + secs * 1000).toISOString();
    q.run(db, 'UPDATE batches SET return_eta_at = ?, return_notified_at = CASE WHEN return_eta_at IS NULL THEN NULL ELSE return_notified_at END WHERE id = ?', eta, batchId);
    return eta;
  }

  /** "Pick up your orders": an out (or just-finished) driver is close to the shop and a run is waiting for him. */
  async function pushReturns() {
    const lead = settings.get('return_push_minutes');
    const rows = q.all(db, "SELECT * FROM batches WHERE status IN ('out','done') AND return_eta_at IS NOT NULL AND return_notified_at IS NULL AND return_eta_at <= ?",
      new Date(now().getTime() + minutes(lead)).toISOString());
    let n = 0;
    for (const b of rows) {
      const waiting = q.get(db, "SELECT id FROM batches WHERE driver_id = ? AND status = 'planned' LIMIT 1", b.driver_id);
      if (!waiting) continue;
      notify.driver(b.driver_id, { kind: 'pickup_next', title: 'Pick up your orders', body: 'You are nearly back — your next run is waiting at the shop.', batchId: waiting.id });
      q.run(db, 'UPDATE batches SET return_notified_at = ? WHERE id = ?', iso(), b.id);
      n++;
    }
    return n;
  }

  /* ------------------------------------------------------------- override */

  /** Admin drags an order to another driver (or null = back to the queue). Only before the order is out. */
  async function moveOrder(orderId, toDriverId, { actor = 'admin' } = {}) {
    const o = orders.need(orderId);
    if (!['ready', 'assigned'].includes(o.state)) throw new AppError(`An order that is ${o.state} cannot be moved`, 409, 'bad_transition');
    const from = o.batch_id;
    if (toDriverId == null) {
      if (o.state === 'assigned') orders.transition(orderId, 'ready', { actor });
      if (o.fleetbase_order_id && o.driver_id) { try { await fleetbase.assign(o.fleetbase_order_id, null); } catch (e) { logger.debug?.(e.message); } }
    } else {
      if (!shifts.open(toDriverId)) throw new AppError('That driver is not clocked in', 409, 'not_in');
      const target = q.get(db, "SELECT * FROM batches WHERE driver_id = ? AND status IN ('assigned','planned') ORDER BY id DESC LIMIT 1", toDriverId);
      const onRun = q.get(db, "SELECT 1 AS x FROM batches WHERE driver_id = ? AND status = 'out'", toDriverId);
      let batchId;
      if (target) {
        const n = q.get(db, 'SELECT COUNT(*) AS n FROM orders WHERE batch_id = ?', target.id).n;
        if (from === target.id) return o;
        batchId = target.id;
        attach(orderId, batchId, toDriverId, n + 1, target.status === 'planned');
      } else {
        batchId = createBatch(toDriverId, [o], { site: o.site_id, preassigned: Boolean(onRun), note: 'set by hand' });
      }
      await resequence(batchId);
      const b = q.get(db, 'SELECT * FROM batches WHERE id = ?', batchId);
      if (b.status === 'assigned') await dispatchBatchToFleetbase(batchId);
    }
    if (from) await settleBatch(from);
    audit.log(actor, 'order.moved', 'order', orderId, { to: toDriverId });
    bus.emit('batch', { batchId: from, status: 'changed' });
    return orders.byId(orderId);
  }

  /** Re-run the sequence for one run after a hand change. */
  async function resequence(batchId) {
    const s = settings.all();
    const home = ctx.sites.store(q.get(db, 'SELECT site_id FROM batches WHERE id = ?', batchId)?.site_id ?? 'main');
    const rows = q.all(db, "SELECT * FROM orders WHERE batch_id = ? AND state = 'assigned'", batchId).map((r) => orders.byId(r.id));
    if (rows.length < 2) { rows.forEach((o, i) => q.run(db, 'UPDATE orders SET stop_seq = ? WHERE id = ?', i + 1, o.id)); return; }
    let ordered;
    try {
      const sol = await vroom.solve({ vehicles: [{ id: 1, start: home, capacity: rows.length, max_tasks: rows.length }], jobs: rows.map((o) => ({ id: o.id, loc: o, service: s.service_minutes_per_drop * 60 })) });
      ordered = sol.routes[0].stops.map((st) => st.job);
    } catch { ordered = nnSequence(home, rows).map((o) => o.id); }
    ordered.forEach((id, i) => q.run(db, 'UPDATE orders SET stop_seq = ? WHERE id = ?', i + 1, id));
  }

  /** A run that lost all its orders is cancelled; otherwise renumber the stops. */
  async function settleBatch(batchId) {
    const left = q.all(db, "SELECT id FROM orders WHERE batch_id = ? AND state = 'assigned' ORDER BY stop_seq", batchId);
    if (!left.length) { q.run(db, "UPDATE batches SET status = 'cancelled' WHERE id = ? AND status IN ('assigned','planned')", batchId); return; }
    await resequence(batchId);
  }

  /** Driver clocked out or went off: lined-up runs (not yet out) go back to the queue. */
  function requeueDriver(driverId) {
    const bs = q.all(db, "SELECT id FROM batches WHERE driver_id = ? AND status IN ('assigned','planned')", driverId);
    for (const b of bs) {
      for (const o of q.all(db, "SELECT id FROM orders WHERE batch_id = ? AND state = 'assigned'", b.id)) orders.transition(o.id, 'ready', { actor: 'batcher', detail: { why: 'driver clocked out' } });
      q.run(db, "UPDATE batches SET status = 'cancelled' WHERE id = ?", b.id);
    }
    return bs.length;
  }

  /** The "send now" button: dispatch whatever is waiting, even part-full. */
  const sendNow = (only = null) => tick({ sendNow: true, only });

  return { tick, plan, sendNow, markOut, deliver, fail, afterDrop, moveOrder, requeueDriver, updateReturnEta, pushReturns, activatePreassigned, resequence, chooseDriver, cluster };
}
