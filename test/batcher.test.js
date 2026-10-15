import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, newOrder, makeReady, clockIn } from './helpers.js';

async function ready(ctx, pc, extra) { return makeReady(ctx, await newOrder(ctx, pc, extra)); }

test('clustered ready orders go to one driver as one run, capped at max_tasks', async () => {
  const ctx = makeCtx({ settings: { max_tasks: 3, batch_hold_minutes: 0 } });
  await clockIn(ctx, 'driver_a');
  for (const pc of ['SW11 5XX', 'SW11 6AA', 'SW11 8AA']) await ready(ctx, pc);
  const r = await ctx.batcher.tick();
  assert.equal(r.assigned.length, 1);
  assert.equal(r.assigned[0].orders.length, 3);
  assert.equal(r.assigned[0].driver, 'driver_a');
  const rows = ctx.orders.list({ states: ['assigned'] });
  assert.deepEqual(rows.map((o) => o.stop_seq).sort(), [1, 2, 3]);
  assert.ok(ctx.fb.calls.some((c) => c[0] === 'dispatch'), 'dispatched in Fleetbase');
});

test('a partial batch waits for the hold time, then goes; "send now" forces it', async () => {
  const ctx = makeCtx({ settings: { max_tasks: 3, batch_hold_minutes: 3 } });
  await clockIn(ctx, 'driver_a');
  await ready(ctx, 'SW11 5XX');
  let r = await ctx.batcher.tick();
  assert.equal(r.assigned.length, 0);
  assert.equal(r.waiting.length, 1);
  assert.ok(r.waiting[0].waits_seconds > 0);
  r = await ctx.batcher.sendNow();
  assert.equal(r.assigned.length, 1, 'send now dispatches the partial batch');
});

test('hold time passing releases a partial batch on its own', async () => {
  const ctx = makeCtx({ settings: { max_tasks: 3, batch_hold_minutes: 3 } });
  await clockIn(ctx, 'driver_a');
  await ready(ctx, 'SW11 5XX');
  assert.equal((await ctx.batcher.tick()).assigned.length, 0);
  ctx.now.advance(4);
  assert.equal((await ctx.batcher.tick()).assigned.length, 1);
});

test('more orders than max_tasks split into several runs for several drivers', async () => {
  const ctx = makeCtx({ settings: { max_tasks: 2, batch_hold_minutes: 0 } });
  await clockIn(ctx, 'driver_a'); await clockIn(ctx, 'driver_b');
  for (const pc of ['SW11 5XX', 'SW11 6AA', 'SW11 8AA', 'SW12 8AA']) await ready(ctx, pc);
  const r = await ctx.batcher.tick();
  assert.equal(r.assigned.length, 2);
  assert.ok(r.assigned.every((a) => a.orders.length <= 2));
  assert.notEqual(r.assigned[0].driver, r.assigned[1].driver);
});

test('distant areas are not batched together (merge distance)', async () => {
  const ctx = makeCtx({ settings: { max_tasks: 4, batch_hold_minutes: 0, radius_km: 50 } });
  await clockIn(ctx, 'driver_a'); await clockIn(ctx, 'driver_b');
  await ready(ctx, 'SW11 5XX'); await ready(ctx, 'N1 5AA');
  const r = await ctx.batcher.tick();
  assert.equal(r.assigned.length, 2);
});

test('max minutes between drops cuts a run', async () => {
  const ctx = makeCtx({ settings: { max_tasks: 4, batch_hold_minutes: 0, radius_km: 50, cluster_merge_km: 50, max_gap_minutes: 5 } });
  await clockIn(ctx, 'driver_a'); await clockIn(ctx, 'driver_b');
  await ready(ctx, 'SW11 5XX'); await ready(ctx, 'N1 5AA');   // ~9 km apart at 30 km/h = 18 min > 5
  const r = await ctx.batcher.tick();
  assert.equal(r.assigned.length, 2, 'two runs, not one');
});

test('no driver at all: orders queue and are picked up when someone clocks in', async () => {
  const ctx = makeCtx({ settings: { max_tasks: 3, batch_hold_minutes: 0 } });
  await ready(ctx, 'SW11 5XX');
  const r = await ctx.batcher.tick();
  assert.equal(r.assigned.length, 0);
  assert.equal(r.queued, 1);
  assert.equal(ctx.orders.list({ states: ['ready'] }).length, 1);
  await clockIn(ctx, 'driver_a');
  assert.equal((await ctx.batcher.tick()).assigned.length, 1);
});

test('driver must be online in Fleetbase to receive work', async () => {
  const ctx = makeCtx({ settings: { batch_hold_minutes: 0 } });
  await clockIn(ctx, 'driver_a');
  ctx.fb.drivers_.get('driver_a').online = false;   // app went offline
  await ready(ctx, 'SW11 5XX');
  assert.equal((await ctx.batcher.tick()).assigned.length, 0);
});

test('strategies: nearest, round robin, fewest jobs', async () => {
  const mk = async (strategy) => {
    const ctx = makeCtx({ settings: { strategy, max_tasks: 1, batch_hold_minutes: 0, radius_km: 50 } });
    await clockIn(ctx, 'far', { lat: 51.55, lng: -0.05 });
    await clockIn(ctx, 'near', { lat: 51.4651, lng: -0.1701 });
    return ctx;
  };
  let ctx = await mk('nearest');
  await ready(ctx, 'SW11 5XX');
  assert.equal((await ctx.batcher.tick()).assigned[0].driver, 'near');

  ctx = await mk('round_robin');
  await ready(ctx, 'SW11 5XX'); await ready(ctx, 'N1 5AA');
  const r1 = await ctx.batcher.tick();
  assert.equal(new Set(r1.assigned.map((a) => a.driver)).size, 2, 'both drivers used in turn');

  ctx = await mk('fewest_jobs');
  await ready(ctx, 'SW11 5XX');
  const r2 = await ctx.batcher.tick();
  const first = r2.assigned[0].driver;
  const b = ctx.orders.list({ states: ['assigned'] })[0];
  await ctx.batcher.markOut(b.batch_id); await ctx.batcher.deliver(b.id);
  await ready(ctx, 'SW11 5XX');
  const r3 = await ctx.batcher.tick();
  assert.notEqual(r3.assigned[0].driver, first, 'the driver with fewer jobs today gets it');
});

test('pre-assign: every driver is out, nearby orders pile onto his next run; he gets it when he returns', async () => {
  const ctx = makeCtx({ settings: { max_tasks: 3, batch_hold_minutes: 0, return_push_minutes: 5 } });
  await clockIn(ctx, 'driver_a');
  const first = await ready(ctx, 'SW11 5XX');
  await ctx.batcher.tick();
  await ctx.batcher.markOut(ctx.orders.byId(first.id).batch_id);
  // new ready orders while he is out
  await ready(ctx, 'SW11 6AA');
  let r = await ctx.batcher.tick();
  assert.equal(r.preassigned.length, 1);
  assert.equal(r.preassigned[0].driver, 'driver_a');
  await ready(ctx, 'SW11 8AA');
  r = await ctx.batcher.tick();
  assert.equal(r.preassigned[0].extended, true, 'second nearby order joined the same pre-assigned run');
  const dispatchedBefore = ctx.fb.calls.filter((c) => c[0] === 'dispatch').length;
  assert.equal(dispatchedBefore, 1, 'pre-assigned orders are not sent to Fleetbase yet');
  // driver finishes his drop -> back -> next run activates
  await ctx.batcher.deliver(first.id);
  r = await ctx.batcher.tick();
  const pre = ctx.orders.list({ states: ['assigned'] });
  assert.equal(pre.length, 2);
  assert.equal(ctx.fb.calls.filter((c) => c[0] === 'dispatch').length, 3, 'now dispatched');
});

test('return ETA push: "pick up your orders" when a next run is waiting and he is close', async () => {
  const ctx = makeCtx({ settings: { max_tasks: 3, batch_hold_minutes: 0, return_push_minutes: 5 } });
  await clockIn(ctx, 'driver_a');
  const first = await ready(ctx, 'SW12 8AA');
  await ctx.batcher.tick();
  await ctx.batcher.markOut(ctx.orders.byId(first.id).batch_id);
  await ready(ctx, 'SW11 6AA');
  await ctx.batcher.tick();                 // pre-assigned
  const eta = Date.parse(q(ctx, "SELECT return_eta_at AS e FROM batches WHERE status = 'out'").e);
  assert.ok(eta > ctx.now().getTime(), 'there is an ETA home');
  assert.equal(await ctx.batcher.pushReturns(), 0, 'not yet close');
  ctx.now.set(new Date(eta - 3 * 60000).toISOString());
  assert.equal(await ctx.batcher.pushReturns(), 1);
  assert.equal(await ctx.batcher.pushReturns(), 0, 'only once');
  const msgs = ctx.notify.inbox('driver_a');
  assert.ok(msgs.some((m) => m.kind === 'pickup_next'));
});

test('manual override: move an assigned order to another driver, or back to the queue', async () => {
  const ctx = makeCtx({ settings: { max_tasks: 3, batch_hold_minutes: 0 } });
  await clockIn(ctx, 'driver_a'); await clockIn(ctx, 'driver_b');
  const o = await ready(ctx, 'SW11 5XX');
  const r = await ctx.batcher.tick();
  const from = r.assigned[0].driver, to = from === 'driver_a' ? 'driver_b' : 'driver_a';
  const moved = await ctx.batcher.moveOrder(o.id, to);
  assert.equal(moved.driver_id, to);
  const cancelled = q(ctx, 'SELECT status FROM batches WHERE driver_id = ? ORDER BY id LIMIT 1', from);
  assert.equal(cancelled.status, 'cancelled', 'emptied run is cancelled');
  const back = await ctx.batcher.moveOrder(o.id, null);
  assert.equal(back.state, 'ready');
  assert.equal(back.driver_id, null);
});

test('cannot move an order that is already out', async () => {
  const ctx = makeCtx({ settings: { batch_hold_minutes: 0 } });
  await clockIn(ctx, 'driver_a'); await clockIn(ctx, 'driver_b');
  const o = await ready(ctx, 'SW11 5XX');
  await ctx.batcher.tick();
  await ctx.batcher.markOut(ctx.orders.byId(o.id).batch_id);
  await assert.rejects(() => ctx.batcher.moveOrder(o.id, 'driver_b'), /cannot be moved/);
});

test('clock out sends lined-up work back to the queue; cannot clock out mid-run', async () => {
  const ctx = makeCtx({ settings: { batch_hold_minutes: 0 } });
  await clockIn(ctx, 'driver_a');
  const o = await ready(ctx, 'SW11 5XX');
  await ctx.batcher.tick();
  await ctx.shifts.clockOut('driver_a');
  assert.equal(ctx.orders.byId(o.id).state, 'ready');
  await clockIn(ctx, 'driver_a');
  await ctx.batcher.tick();
  await ctx.batcher.markOut(ctx.orders.byId(o.id).batch_id);
  await assert.rejects(() => ctx.shifts.clockOut('driver_a'), /Finish your current run/);
});

test('failed delivery: reason required, order can be re-queued and joins the next batch', async () => {
  const ctx = makeCtx({ settings: { batch_hold_minutes: 0 } });
  await clockIn(ctx, 'driver_a');
  const o = await ready(ctx, 'SW11 5XX');
  await ctx.batcher.tick();
  await ctx.batcher.markOut(ctx.orders.byId(o.id).batch_id);
  await assert.rejects(() => ctx.batcher.fail(o.id, {}), /reason/);
  await ctx.batcher.fail(o.id, { reason: 'No answer', photo: 'door.jpg' });
  assert.equal(ctx.orders.byId(o.id).state, 'failed');
  ctx.orders.transition(o.id, 'ready', { actor: 'admin' });
  const r = await ctx.batcher.tick();
  assert.equal(r.assigned.length, 1);
});

test('VROOM down: runs are still built (local sequencing) and flagged', async () => {
  const ctx = makeCtx({ vroomFail: true, settings: { max_tasks: 3, batch_hold_minutes: 0 } });
  await clockIn(ctx, 'driver_a');
  await ready(ctx, 'SW11 5XX'); await ready(ctx, 'SW11 6AA');
  const r = await ctx.batcher.tick();
  assert.equal(r.engine, 'local');
  assert.equal(r.assigned[0].orders.length, 2);
});

test('Fleetbase failing does not lose the assignment', async () => {
  const ctx = makeCtx({ settings: { batch_hold_minutes: 0 } });
  await clockIn(ctx, 'driver_a');
  const o = await ready(ctx, 'SW11 5XX');
  ctx.fb.failOn.add('dispatch');
  const r = await ctx.batcher.tick();
  assert.equal(r.assigned.length, 1);
  assert.equal(ctx.orders.byId(o.id).state, 'assigned');
});

function q(ctx, sql, ...p) { return ctx.db.prepare(sql).get(...p); }
