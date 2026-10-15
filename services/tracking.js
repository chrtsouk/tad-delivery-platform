/** Customer tracking: what the public page shows for one order — steps, queue position, driver marker, OSRM ETA. */
import { q } from '../lib/db.js';
import { AppError } from '../lib/util.js';
import { verify } from '../lib/tokens.js';
import { estimateSeconds } from '../lib/route.js';

export const STEPS = [
  { key: 'placed', label: 'Order placed', states: ['scheduled', 'new'] },
  { key: 'accepted', label: 'Accepted', states: ['accepted'] },
  { key: 'preparing', label: 'Being made', states: ['preparing'] },
  { key: 'ready', label: 'Ready — finding your driver', states: ['ready', 'assigned'] },
  { key: 'out', label: 'Out for delivery', states: ['out'] },
  { key: 'delivered', label: 'Delivered', states: ['delivered', 'collected'] },
];
const BEFORE_OUT = ['new', 'accepted', 'preparing', 'ready', 'assigned'];

export function createTracking(ctx) {
  const { db, now, settings, orders, fleetbase, osrm, config, logger = console } = ctx;

  function orderForToken(token) {
    const number = verify(ctx.trackSecret, decodeURIComponent(token));
    const o = number && orders.byNumber(number);
    if (!o) throw new AppError('We could not find that order', 404, 'not_found');
    return o;
  }

  /** How many orders are ahead: before it leaves, the orders placed earlier that are not out yet; on the road, drops before yours. */
  function queuePosition(o) {
    if (BEFORE_OUT.includes(o.state)) {
      return q.get(db, "SELECT COUNT(*) AS n FROM orders WHERE fulfilment = 'delivery' AND state IN ('new','accepted','preparing','ready','assigned') AND (COALESCE(accepted_at, created_at) < COALESCE(?, ?) OR (COALESCE(accepted_at, created_at) = COALESCE(?, ?) AND id < ?))",
        o.accepted_at, o.created_at, o.accepted_at, o.created_at, o.id).n + 1;
    }
    if (o.state === 'out' && o.batch_id) {
      return q.get(db, "SELECT COUNT(*) AS n FROM orders WHERE batch_id = ? AND state = 'out' AND stop_seq < ?", o.batch_id, o.stop_seq).n + 1;
    }
    return null;
  }

  async function driverPoint(o) {
    if (!o.driver_id) return null;
    try {
      const d = await fleetbase.driver(o.driver_id);
      const c = d.location?.coordinates;
      if (c && (c[0] || c[1])) return { lat: c[1], lng: c[0], name: (d.name || '').split(' ')[0], phone: d.phone || null, heading: d.heading ?? null };
    } catch (e) { logger.debug?.(e.message); }
    return null;
  }

  /** ETA in minutes. On the road: OSRM driver -> each drop up to this one + door time. Before: prep + default travel. */
  async function etaMinutes(o, driver) {
    const s = settings.all();
    if (['delivered', 'collected', 'cancelled', 'removed', 'failed'].includes(o.state)) return null;
    if (o.state === 'out' && driver && o.lat != null) {
      const ahead = q.all(db, "SELECT lat, lng FROM orders WHERE batch_id = ? AND state = 'out' AND stop_seq <= ? ORDER BY stop_seq", o.batch_id, o.stop_seq);
      let secs = 0, cur = driver;
      for (const stop of ahead) {
        try { secs += (await osrm.route(cur, stop)).seconds; } catch { secs += estimateSeconds(cur, stop); }
        secs += s.service_minutes_per_drop * 60; cur = stop;
      }
      return Math.max(1, Math.round(secs / 60));
    }
    const sinceAccepted = o.accepted_at ? (now().getTime() - Date.parse(o.accepted_at)) / 60000 : 0;
    return Math.max(5, Math.round(s.default_eta_minutes - sinceAccepted));
  }

  async function view(token) {
    const o = orderForToken(token);
    const s = settings.all();
    const idx = STEPS.findIndex((st) => st.states.includes(o.state));
    const driver = o.state === 'out' ? await driverPoint(o) : null;
    const eta = await etaMinutes(o, driver);
    return {
      number: o.number, state: o.state, fulfilment: o.fulfilment,
      steps: STEPS.map((st, i) => ({ key: st.key, label: st.label, done: idx >= 0 && i <= idx, current: i === idx })),
      closed: ['cancelled', 'removed'].includes(o.state), failed: o.state === 'failed',
      queue_position: queuePosition(o),
      eta_minutes: eta, eta_at: eta != null ? new Date(now().getTime() + eta * 60000).toISOString() : null,
      driver: driver ? { first_name: driver.name, lat: driver.lat, lng: driver.lng, heading: driver.heading, phone: s.show_driver_phone ? driver.phone : null } : null,
      destination: o.lat != null ? { lat: o.lat, lng: o.lng, postcode: o.postcode } : null,
      store: { name: s.store.name, lat: s.store.lat, lng: s.store.lng, phone: s.store.phone || null },
      items: o.items, placed_at: o.created_at, delivered_at: o.delivered_at, can_rate: ['delivered', 'collected'].includes(o.state) && o.rating == null, rating: o.rating,
      push_public_key: ctx.notify.vapidPublicKey,
    };
  }

  function rate(token, rating) {
    const o = orderForToken(token);
    if (!['delivered', 'collected'].includes(o.state)) throw new AppError('You can rate an order once it has arrived', 409, 'too_early');
    const n = Number(rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new AppError('Rating is 1 to 5');
    q.run(db, 'UPDATE orders SET rating = ? WHERE id = ?', n, o.id);
    orders.event(o.id, 'rated', { rating: n });
    return { rating: n };
  }

  /** For the owner's own ordering site: a quote before the customer pays (deliverable? fee? ETA?). */
  async function quote({ postcode, lat, lng }) {
    const { normalisePostcode } = await import('../lib/geo.js');
    const pc = normalisePostcode(postcode);
    let p = lat != null ? { lat, lng } : await ctx.postcodes.lookup(pc.postcode);
    if (!p) throw new AppError(`We could not find ${pc.postcode} on the map`, 422, 'unknown_postcode');
    const s = settings.all();
    try { const km = orders.checkDeliverable({ lat: p.lat, lng: p.lng, outcode: pc.outcode }); return { deliverable: true, fee_pence: orders.deliveryFee(km), eta_minutes: s.default_eta_minutes, open: s.open, distance_km: Math.round(km * 10) / 10 }; }
    catch (e) { if (e.code === 'outside_area') return { deliverable: false, reason: e.message, open: s.open }; throw e; }
  }

  return { view, rate, quote, orderForToken, queuePosition };
}
