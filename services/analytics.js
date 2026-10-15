/** Analytics: demand heatmap data, driver performance (no money), end-of-day report, audit log. Plain SQL over our order timestamps. */
import Supercluster from 'supercluster';
import { q } from '../lib/db.js';
import { localParts, dayRangeUtc } from '../lib/tz.js';

const mins = (a, b) => (a && b ? (Date.parse(b) - Date.parse(a)) / 60000 : null);
const avg = (xs) => { const v = xs.filter((x) => x != null); return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10 : null; };
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

export function createAnalytics(ctx) {
  const { db, settings, audit } = ctx;
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  /** from/to may be ISO instants or plain dates; a plain date means that day's start in SHOP time. */
  const range = (from, to) => {
    const tz = settings.get('timezone');
    const edge = (v, dflt) => (!v ? dflt : DAY.test(v) ? dayRangeUtc(v, tz)[0] : v);
    return { from: edge(from, '0000'), to: edge(to, '9999') };
  };

  /** Busy times and areas. `points` is GeoJSON-ready for MapLibre's heatmap layer; `clusters` uses supercluster by area. */
  function demand({ from, to, zoom = 11 } = {}) {
    const r = range(from, to);
    const rows = q.all(db, "SELECT lat, lng, outcode, created_at FROM orders WHERE fulfilment = 'delivery' AND state NOT IN ('cancelled','removed') AND lat IS NOT NULL AND created_at >= ? AND created_at < ?", r.from, r.to);
    const hours = Array.from({ length: 7 }, () => Array(24).fill(0));
    const byOut = new Map();
    for (const o of rows) {
      const lp = localParts(new Date(o.created_at), settings.get('timezone'));
      hours[lp.dow][lp.h]++;
      byOut.set(o.outcode, (byOut.get(o.outcode) ?? 0) + 1);
    }
    const features = rows.map((o) => ({ type: 'Feature', properties: { weight: 1, outcode: o.outcode }, geometry: { type: 'Point', coordinates: [o.lng, o.lat] } }));
    const sc = new Supercluster({ radius: 60, maxZoom: 16 }).load(features);
    return {
      total: rows.length,
      points: { type: 'FeatureCollection', features },
      clusters: sc.getClusters([-180, -85, 180, 85], zoom),
      by_hour_of_week: { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], matrix: hours },
      by_area: [...byOut].map(([outcode, orders]) => ({ outcode, orders })).sort((a, b) => b.orders - a.orders),
    };
  }

  /** Per driver: deliveries, on-time %, average pickup -> drop minutes, failures. NO money. */
  function driverPerformance({ from, to } = {}) {
    const r = range(from, to);
    const late = settings.get('late_after_minutes');
    const rows = q.all(db, `SELECT driver_id, state, created_at, accepted_at, out_at, delivered_at FROM orders WHERE driver_id IS NOT NULL AND fulfilment = 'delivery'
      AND state IN ('delivered','failed') AND COALESCE(delivered_at, failed_at, out_at, created_at) >= ? AND COALESCE(delivered_at, failed_at, out_at, created_at) < ?`, r.from, r.to);
    const names = new Map(q.all(db, 'SELECT driver_id, MAX(driver_name) AS n FROM driver_shifts GROUP BY driver_id').map((x) => [x.driver_id, x.n]));
    const by = new Map();
    for (const o of rows) (by.get(o.driver_id) ?? by.set(o.driver_id, []).get(o.driver_id)).push(o);
    return [...by].map(([id, os]) => {
      const done = os.filter((o) => o.state === 'delivered');
      const onTime = done.filter((o) => mins(o.accepted_at ?? o.created_at, o.delivered_at) <= late).length;
      return {
        driver_id: id, name: names.get(id) ?? null, deliveries: done.length, failed: os.length - done.length,
        on_time_pct: pct(onTime, done.length), avg_pickup_to_drop_min: avg(done.map((o) => mins(o.out_at, o.delivered_at))),
        avg_order_to_door_min: avg(done.map((o) => mins(o.accepted_at ?? o.created_at, o.delivered_at))),
      };
    }).sort((a, b) => b.deliveries - a.deliveries);
  }

  /** End of day for one shop-local calendar day (YYYY-MM-DD, in the `timezone` setting). */
  function endOfDay(day) {
    const [from, to] = dayRangeUtc(day, settings.get('timezone'));
    const orders = q.all(db, 'SELECT * FROM orders WHERE created_at >= ? AND created_at < ?', from, to);
    const late = settings.get('late_after_minutes');
    const count = (f) => orders.filter(f).length;
    const delivered = orders.filter((o) => o.state === 'delivered');
    const failed = orders.filter((o) => o.fail_reason && o.state !== 'cancelled' || o.state === 'failed');
    const shifts = q.all(db, 'SELECT driver_id, driver_name, clock_in_at, clock_out_at, zone FROM driver_shifts WHERE clock_in_at >= ? AND clock_in_at < ? ORDER BY clock_in_at', from, to)
      .map((s) => ({ ...s, hours: s.clock_out_at ? Math.round(((Date.parse(s.clock_out_at) - Date.parse(s.clock_in_at)) / 3600000) * 10) / 10 : null }));
    return {
      day, orders: orders.length, delivered: delivered.length, collected: count((o) => o.state === 'collected'), cancelled: count((o) => o.state === 'cancelled'),
      failed: count((o) => o.state === 'failed'), still_open: count((o) => ['new', 'accepted', 'preparing', 'ready', 'assigned', 'out'].includes(o.state)),
      late: delivered.filter((o) => mins(o.accepted_at ?? o.created_at, o.delivered_at) > late).length,
      on_time_pct: pct(delivered.filter((o) => mins(o.accepted_at ?? o.created_at, o.delivered_at) <= late).length, delivered.length),
      avg_order_to_door_min: avg(delivered.map((o) => mins(o.accepted_at ?? o.created_at, o.delivered_at))),
      by_source: Object.entries(orders.reduce((m, o) => ({ ...m, [o.source]: (m[o.source] ?? 0) + 1 }), {})).map(([source, n]) => ({ source, orders: n })),
      failures: failed.map((o) => ({ number: o.number, reason: o.fail_reason, postcode: o.postcode, state: o.state })),
      drivers: driverPerformance({ from, to }),
      shifts,
      audit_events: audit.recent(500, { from, to }).length,
    };
  }

  const csvCell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  /** Orders as CSV (no money columns beyond the order total the customer already paid online). */
  function ordersCsv({ from, to } = {}) {
    const r = range(from, to);
    const rows = q.all(db, 'SELECT * FROM orders WHERE created_at >= ? AND created_at < ? ORDER BY created_at', r.from, r.to);
    const head = ['number', 'created_at', 'source', 'fulfilment', 'state', 'customer_name', 'postcode', 'items', 'driver_id', 'accepted_at', 'ready_at', 'out_at', 'delivered_at', 'minutes_order_to_door', 'fail_reason', 'rating'];
    const lines = rows.map((o) => [o.number, o.created_at, o.source, o.fulfilment, o.state, o.customer_name, o.postcode, JSON.parse(o.items_json).map((i) => `${i.qty} x ${i.name}`).join('; '), o.driver_id, o.accepted_at, o.ready_at, o.out_at, o.delivered_at, mins(o.accepted_at ?? o.created_at, o.delivered_at)?.toFixed(1), o.fail_reason, o.rating].map(csvCell).join(','));
    return [head.join(','), ...lines].join('\n') + '\n';
  }

  return { demand, driverPerformance, endOfDay, ordersCsv, auditLog: (limit, range_) => audit.recent(limit, range_) };
}
