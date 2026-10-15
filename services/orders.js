/**
 * Orders: the one order schema every channel maps into (modelled on glitchr-studio/omnifood's Order: source, external id,
 * customer, address, items, totals, status timestamps), the state machine, and the mirror into Fleetbase.
 *
 *   scheduled ─release─▶ new ─▶ accepted ─▶ preparing ─▶ ready ─▶ assigned ─▶ out ─▶ delivered
 *                         └──────────── cancelled (any open state)      ready ◀── failed ◀──┘   (failed: requeue | removed)
 *   collection orders: ready ─▶ collected
 */
import { q, tx } from '../lib/db.js';
import { AppError, text } from '../lib/util.js';
import { normalisePostcode, normalisePhone, haversineKm } from '../lib/geo.js';
import { sign } from '../lib/tokens.js';

export const STATES = ['scheduled', 'new', 'accepted', 'preparing', 'ready', 'assigned', 'out', 'delivered', 'collected', 'failed', 'removed', 'cancelled'];
export const OPEN_STATES = ['new', 'accepted', 'preparing', 'ready', 'assigned', 'out'];
const NEXT = {
  scheduled: ['new', 'cancelled'],
  new: ['accepted', 'cancelled'],
  accepted: ['preparing', 'ready', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['assigned', 'collected', 'cancelled'],
  assigned: ['out', 'ready', 'cancelled'],
  out: ['delivered', 'failed'],
  failed: ['ready', 'removed', 'cancelled'],
  delivered: [], collected: [], removed: [], cancelled: [],
};
const TIME_COL = { accepted: 'accepted_at', ready: 'ready_at', assigned: 'assigned_at', out: 'out_at', delivered: 'delivered_at', collected: 'delivered_at', failed: 'failed_at', cancelled: 'cancelled_at' };

export function createOrders(ctx) {
  const { db, now, settings, bus, audit, postcodes, fleetbase, logger = console } = ctx;
  const iso = () => now().toISOString();

  const hydrate = (r) => (r ? { ...r, items: JSON.parse(r.items_json), paid: Boolean(r.paid) } : null);
  const byId = (id) => hydrate(q.get(db, 'SELECT * FROM orders WHERE id = ?', id));
  const byNumber = (n) => hydrate(q.get(db, 'SELECT * FROM orders WHERE number = ?', n));
  const need = (id) => { const o = byId(id); if (!o) throw new AppError('That order does not exist', 404, 'not_found'); return o; };

  function nextNumber() {
    const day = iso().slice(0, 10).replace(/-/g, '');
    const row = tx(db, () => {
      q.run(db, 'INSERT INTO order_seq(day,n) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET n = n + 1', day);
      return q.get(db, 'SELECT n FROM order_seq WHERE day = ?', day);
    });
    return `TAD-${day}-${String(row.n).padStart(3, '0')}`;
  }

  function event(orderId, type, detail) {
    q.run(db, 'INSERT INTO order_events(order_id,at,type,detail) VALUES(?,?,?,?)', orderId, iso(), type, detail ? JSON.stringify(detail) : null);
  }

  /** Is this drop inside the area the owner set (radius + excluded districts)? Mirrors the Fleetbase service area. */
  function checkDeliverable({ lat, lng, outcode }) {
    const s = settings.all();
    if (outcode && s.excluded_outcodes.includes(outcode)) throw new AppError(`Sorry, we do not deliver to ${outcode}`, 422, 'outside_area');
    if (lat != null && lng != null) {
      const km = haversineKm(s.store, { lat, lng });
      if (km > s.radius_km) throw new AppError(`That address is ${km.toFixed(1)} km away; we deliver up to ${s.radius_km} km`, 422, 'outside_area');
      return km;
    }
    return null;
  }

  function deliveryFee(km) {
    const bands = [...settings.get('fee_bands')].sort((a, b) => a.up_to_km - b.up_to_km);
    const b = bands.find((x) => km <= x.up_to_km);
    return b ? b.fee_pence : null;
  }

  /** Normalise any channel's order into one schema and store it. Idempotent on (source, external_id). */
  async function create(input, { actor = 'system' } = {}) {
    const source = text(input.source, 40, 'source', { required: true });
    const externalId = input.external_id ? String(input.external_id) : null;
    if (externalId) {
      const dup = q.get(db, 'SELECT id FROM orders WHERE source = ? AND external_id = ?', source, externalId);
      if (dup) return { order: byId(dup.id), duplicate: true };
    }
    const fulfilment = input.fulfilment === 'collection' ? 'collection' : 'delivery';
    const items = (input.items || []).map((i) => ({ name: text(i.name, 120, 'item name', { required: true }), qty: Math.max(1, Math.round(Number(i.qty) || 1)), price_pence: Number.isFinite(i.price_pence) ? Math.round(i.price_pence) : null }));
    if (!items.length) throw new AppError('An order needs at least one item');
    const customer = input.customer || {};
    const phone = customer.phone ? normalisePhone(customer.phone) : null;
    const a = input.address || {};
    let pc = null, lat = a.lat ?? null, lng = a.lng ?? null, km = null;
    if (fulfilment === 'delivery') {
      pc = normalisePostcode(a.postcode);
      if (lat == null || lng == null) {
        const hit = await postcodes.lookup(pc.postcode);
        if (!hit) throw new AppError(`We could not find ${pc.postcode} on the map`, 422, 'unknown_postcode');
        lat = hit.lat; lng = hit.lng;
      }
      km = checkDeliverable({ lat, lng, outcode: pc.outcode });
      if (!text(a.line1, 160, 'address', { required: true })) throw new AppError('Address is needed');
    }
    const fee = input.delivery_fee_pence ?? (fulfilment === 'delivery' && km != null ? deliveryFee(km) : null);
    const number = nextNumber();
    const scheduled = input.scheduled_for ? new Date(input.scheduled_for).toISOString() : null;
    const state = scheduled && Date.parse(scheduled) > now().getTime() ? 'scheduled' : 'new';
    const r = q.run(db, `INSERT INTO orders(number, site_id, source, external_id, fulfilment, state, customer_name, customer_phone, customer_email,
        address_line, postcode, outcode, lat, lng, items_json, item_count, notes, total_pence, delivery_fee_pence, paid, scheduled_for, created_at, track_token, hub_order_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      number, input.site_id || 'main', source, externalId, fulfilment, state, text(customer.name, 80, 'customer name'), phone, customer.email ? String(customer.email).toLowerCase().slice(0, 120) : null,
      fulfilment === 'delivery' ? text(a.line1, 160, 'address') : null, pc?.postcode ?? null, pc?.outcode ?? null, lat, lng,
      JSON.stringify(items), items.reduce((n, i) => n + i.qty, 0), text(input.notes, 500, 'notes'), input.total_pence ?? null, fee, input.paid === false ? 0 : 1, scheduled, iso(), sign(ctx.trackSecret, number), input.hub_order_id ?? null);
    const id = Number(r.lastInsertRowid);
    event(id, 'created', { source, state });
    audit.log(actor, 'order.create', 'order', id, { number, source });
    if (fulfilment === 'delivery' && phone && pc) rememberAddress({ phone, postcode: pc.postcode, name: customer.name, line1: a.line1, lat, lng });
    const order = byId(id);
    bus.emit('order', { order, from: null, to: state });
    syncToFleetbase(order).catch((e) => logger.warn?.(`Fleetbase sync for ${number} will retry: ${e.message}`));
    return { order, duplicate: false };
  }

  /** The self-building address book: one row per (phone, postcode), refreshed on every order. */
  function rememberAddress({ phone, postcode, name, line1, lat, lng }) {
    q.run(db, `INSERT INTO customer_addresses(phone_norm, postcode, name, address_line, lat, lng, uses, last_used_at) VALUES(?,?,?,?,?,?,1,?)
      ON CONFLICT(phone_norm, postcode) DO UPDATE SET name = COALESCE(excluded.name, name), address_line = excluded.address_line,
      lat = COALESCE(excluded.lat, lat), lng = COALESCE(excluded.lng, lng), uses = uses + 1, last_used_at = excluded.last_used_at`,
    phone, postcode, name ?? null, line1, lat ?? null, lng ?? null, iso());
  }

  function findAddresses({ phone, query }) {
    const rows = [];
    if (phone) {
      let p; try { p = normalisePhone(phone); } catch { p = null; }
      if (p) rows.push(...q.all(db, 'SELECT * FROM customer_addresses WHERE phone_norm = ? ORDER BY uses DESC, last_used_at DESC LIMIT 5', p));
    }
    if (query && String(query).trim().length >= 3) {
      const like = `%${String(query).trim().replace(/[%_]/g, '')}%`;
      rows.push(...q.all(db, 'SELECT * FROM customer_addresses WHERE address_line LIKE ?1 OR postcode LIKE ?1 OR name LIKE ?1 ORDER BY uses DESC LIMIT 5', like));
    }
    const seen = new Set();
    return rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
  }

  /** Create the matching Fleetbase order (unmodified Fleetbase, via its API). Safe to call again: it only runs once. */
  async function syncToFleetbase(order) {
    if (order.fulfilment !== 'delivery' || order.fleetbase_order_id || ['scheduled', 'cancelled', 'removed'].includes(order.state)) return order;
    const s = settings.all();
    const pickup = await fleetbase.createPlace({ name: s.store.name, street1: s.store.address || s.store.name, postal_code: s.store.postcode, country: 'GB', latitude: s.store.lat, longitude: s.store.lng });
    const drop = await fleetbase.createPlace({ name: order.customer_name || order.address_line, street1: order.address_line, postal_code: order.postcode, country: 'GB', latitude: order.lat, longitude: order.lng, phone: order.customer_phone });
    const fb = await fleetbase.createOrder({
      pickup: pickup.id, dropoff: drop.id,
      customer: order.customer_name ? Object.fromEntries(Object.entries({ name: order.customer_name, phone: order.customer_phone, email: order.customer_email }).filter(([, v]) => v)) : undefined,
      notes: order.notes, meta: { tad_number: order.number, tad_id: order.id, source: order.source, items: order.items, postcode: order.postcode },
    });
    q.run(db, 'UPDATE orders SET fleetbase_order_id = ?, fleetbase_tracking = ? WHERE id = ? AND fleetbase_order_id IS NULL', fb.id, fb.tracking_number?.tracking_number ?? null, order.id);
    event(order.id, 'fleetbase_synced', { id: fb.id });
    return byId(order.id);
  }

  function transition(id, to, { actor = 'admin', reason = null, photo = null, detail = null } = {}) {
    const o = need(id);
    if (!NEXT[o.state]?.includes(to)) throw new AppError(`An order that is ${o.state} cannot become ${to}`, 409, 'bad_transition');
    if (to === 'collected' && o.fulfilment !== 'collection') throw new AppError('Only collection orders are collected', 409, 'bad_transition');
    if (to === 'failed' && !reason) throw new AppError('A reason is needed when a delivery fails');
    if (to === 'cancelled' && !reason) throw new AppError('A reason is needed to cancel an order');
    const sets = ['state = ?'], vals = [to];
    if (TIME_COL[to]) { sets.push(`${TIME_COL[to]} = ?`); vals.push(iso()); }
    if (to === 'ready' && o.state === 'failed') { sets.push('driver_id = NULL', 'batch_id = NULL', 'stop_seq = NULL', 'out_at = NULL', 'assigned_at = NULL'); }
    if (to === 'ready' && o.state === 'assigned') { sets.push('driver_id = NULL', 'batch_id = NULL', 'stop_seq = NULL', 'assigned_at = NULL'); }
    if (to === 'failed') { sets.push('fail_reason = ?', 'fail_photo = ?'); vals.push(reason, photo); }
    if (to === 'cancelled') { sets.push('fail_reason = ?'); vals.push(reason); }
    q.run(db, `UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    event(id, `state:${to}`, { from: o.state, reason, ...(detail || {}) });
    audit.log(actor, `order.${to}`, 'order', id, { number: o.number, from: o.state, reason });
    const order = byId(id);
    bus.emit('order', { order, from: o.state, to });
    return order;
  }

  /** Orders a pre-order has been waiting for: release the ones whose time is within the prep window. */
  function releaseScheduled() {
    const lead = settings.get('prep_minutes') + settings.get('default_eta_minutes') / 2;
    const cutoff = new Date(now().getTime() + lead * 60000).toISOString();
    const due = q.all(db, "SELECT id FROM orders WHERE state = 'scheduled' AND scheduled_for <= ?", cutoff);
    return due.map((d) => transition(d.id, 'new', { actor: 'scheduler' }));
  }

  async function retryFleetbaseSync() {
    const todo = q.all(db, "SELECT id FROM orders WHERE fulfilment='delivery' AND fleetbase_order_id IS NULL AND state NOT IN ('scheduled','cancelled','removed','delivered')");
    for (const t of todo) { try { await syncToFleetbase(byId(t.id)); } catch (e) { logger.warn?.(`Fleetbase sync retry for order ${t.id}: ${e.message}`); } }
    return todo.length;
  }

  function list({ states, since, limit = 300 } = {}) {
    const st = states?.length ? states : OPEN_STATES.concat(['scheduled', 'failed']);
    const ph = st.map(() => '?').join(',');
    return q.all(db, `SELECT * FROM orders WHERE state IN (${ph}) AND (? IS NULL OR created_at >= ?) ORDER BY created_at ASC LIMIT ?`, ...st, since ?? null, since ?? null, limit).map(hydrate);
  }

  const timeline = (id) => q.all(db, 'SELECT at, type, detail FROM order_events WHERE order_id = ? ORDER BY id', id).map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null }));

  return { create, byId, byNumber, need, transition, list, timeline, findAddresses, rememberAddress, syncToFleetbase, retryFleetbaseSync, releaseScheduled, checkDeliverable, deliveryFee, event };
}
