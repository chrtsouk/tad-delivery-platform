/**
 * Hub sync: the management app hub (tad-management-app) stays the source of truth.
 *   out   every order we take is put on the hub's kitchen pass (POST /api/v1/orders) so the kitchen sees it
 *   in    the kitchen marking an order Ready (event stream or signed webhook) moves our order to Ready
 *   erase a customer who asked to be erased is blanked here too (orders + address book)
 */
import crypto from 'node:crypto';
import { q } from '../lib/db.js';
import { AppError } from '../lib/util.js';
import { safeEqual } from '../lib/tokens.js';
import { normalisePhone } from '../lib/geo.js';

export function createHubSync(ctx) {
  const { db, now, config, hub, orders, audit, logger = console } = ctx;
  const iso = () => now().toISOString();

  const pushing = new Map();
  function pushOrder(order) {
    // the order-created event and the retry loop must never both post the same order (duplicate kitchen tickets)
    if (!hub.enabled() || order.hub_order_id || order.source === 'hub') return Promise.resolve(null);
    if (!pushing.has(order.id)) pushing.set(order.id, doPush(order).finally(() => pushing.delete(order.id)));
    return pushing.get(order.id);
  }
  async function doPush(order) {
    const res = await hub.postOrder({
      source: 'tad-delivery', external_ref: order.number, channel: order.source, customer: order.customer_name, note: [order.fulfilment === 'collection' ? 'COLLECTION' : 'DELIVERY', order.notes].filter(Boolean).join(' — '),
      lines: order.items.map((i) => ({ name: i.name, qty: i.qty })),
    });
    if (res?.id != null) q.run(db, 'UPDATE orders SET hub_order_id = ? WHERE id = ?', String(res.id), order.id);
    return res;
  }

  async function pushPending() {
    if (!hub.enabled()) return 0;
    let n = 0;
    for (const r of q.all(db, "SELECT id FROM orders WHERE hub_order_id IS NULL AND source != 'hub' AND state NOT IN ('scheduled','cancelled','removed') LIMIT 50")) {
      try { await pushOrder(orders.byId(r.id)); n++; } catch (e) { logger.warn?.(`hub push for order ${r.id} will retry: ${e.message}`); }
    }
    return n;
  }

  const cursor = () => Number(q.get(db, "SELECT data FROM integrations WHERE name = 'hub_cursor'")?.data ?? 0);
  const saveCursor = (c) => q.run(db, "INSERT INTO integrations(name,data,updated_at) VALUES('hub_cursor',?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at", String(c), iso());

  /** Apply one hub change event. Returns true if it changed something here. */
  function applyEvent(ev) {
    if (ev.entity === 'kitchen_order' && ev.field === 'status' && ev.new === 'ready') {
      const o = q.get(db, 'SELECT id, state FROM orders WHERE hub_order_id = ?', String(ev.entity_id));
      if (!o) return false;
      if (['accepted', 'preparing'].includes(o.state)) { orders.transition(o.id, 'ready', { actor: 'hub' }); return true; }
      if (o.state === 'new') { orders.transition(o.id, 'accepted', { actor: 'hub' }); orders.transition(o.id, 'ready', { actor: 'hub' }); return true; }
    }
    if (ev.entity === 'kitchen_order' && ev.field === 'status' && ev.new === 'cancelled') {
      const o = q.get(db, 'SELECT id, state FROM orders WHERE hub_order_id = ?', String(ev.entity_id));
      if (o && ['new', 'accepted', 'preparing', 'ready', 'assigned'].includes(o.state)) { orders.transition(o.id, 'cancelled', { actor: 'hub', reason: 'Cancelled on the kitchen pass' }); return true; }
    }
    return false;
  }

  async function pollEvents() {
    if (!hub.enabled()) return 0;
    const { events, next_cursor: next } = await hub.events(cursor());
    let n = 0;
    for (const ev of events || []) if (applyEvent(ev)) n++;
    if (next != null) saveCursor(next);
    return n;
  }

  /** Signed hub webhooks: x-tad-signature = "sha256=" + HMAC-SHA256(secret, `${x-tad-timestamp}.${body}`). */
  function verifyWebhook(raw, timestamp, signature) {
    if (!config.hub.webhookSecret) throw new AppError('The hub webhook secret is not set', 503, 'not_configured');
    const mac = crypto.createHmac('sha256', config.hub.webhookSecret).update(`${timestamp}.${raw}`).digest('hex');
    if (!safeEqual(`sha256=${mac}`, String(signature ?? ''))) return false;
    return Math.abs(now().getTime() - Number(timestamp) * (String(timestamp).length <= 10 ? 1000 : 1)) < 10 * 60000;
  }

  /** GDPR erase: blank the person on every order and drop their saved addresses. Orders stay (the times and areas are records). */
  function erasePerson({ phone }) {
    const p = normalisePhone(phone);
    if (!p) throw new AppError('A phone number is needed to find the person');
    const rows = q.all(db, 'SELECT id, fb_dropoff_place, fb_customer FROM orders WHERE customer_phone = ?', p);
    // the person, the address, the coordinates and the live tracking link go; the order record (times, district, items) stays
    const r = q.run(db, "UPDATE orders SET customer_name = NULL, customer_phone = NULL, customer_email = NULL, address_line = '(erased)', postcode = NULL, lat = NULL, lng = NULL, notes = NULL, track_token = NULL, fb_dropoff_place = NULL, fb_customer = NULL, custom_json = NULL WHERE customer_phone = ?", p);
    const a = q.run(db, 'DELETE FROM customer_addresses WHERE phone_norm = ?', p);
    q.run(db, "UPDATE customer_flags SET label = '(erased)', value_key = '(erased)', reason = '(erased)', cleared_at = COALESCE(cleared_at, ?), cleared_by = COALESCE(cleared_by, 'privacy erase') WHERE kind = 'phone' AND value_key = ?", now().toISOString(), p);
    // Fleetbase's own copies (place + contact), best effort
    for (const o of rows) {
      if (o.fb_dropoff_place) Promise.resolve().then(() => ctx.fleetbase.deletePlace(o.fb_dropoff_place)).catch((e) => logger.warn?.(`Fleetbase place erase: ${e.message}`));
      if (o.fb_customer) Promise.resolve().then(() => ctx.fleetbase.deleteContact(o.fb_customer)).catch((e) => logger.warn?.(`Fleetbase contact erase: ${e.message}`));
    }
    audit.log('system', 'privacy.erase', 'customer', p.slice(-4), { orders: r.changes, addresses: a.changes, note: 'the hub keeps its own copy: erase it there too' });
    return { orders: Number(r.changes), addresses: Number(a.changes), fleetbase_copies_requested: rows.filter((o) => o.fb_dropoff_place || o.fb_customer).length };
  }

  return { pushOrder, pushPending, pollEvents, applyEvent, verifyWebhook, erasePerson };
}
