/** Incidents: a driver or the admin logs a problem against an order and/or a driver (type, note, photo, time). Every one also lands in the audit log. */
import { q } from '../lib/db.js';
import { AppError, csvCell, text } from '../lib/util.js';

export const INCIDENT_TYPES = {
  customer_unavailable: 'Customer not available',
  wrong_address: 'Wrong or unreachable address',
  customer_conduct: 'Rude or aggressive customer',
  order_problem: 'Problem with the order (missing, damaged, wrong)',
  vehicle: 'Vehicle problem',
  accident: 'Accident or injury',
  safety: 'Safety concern',
  other: 'Other',
};

export function createIncidents(ctx) {
  const { db, now, audit, orders } = ctx;
  const iso = () => now().toISOString();
  const get = (id) => q.get(db, 'SELECT * FROM incidents WHERE id = ?', id);

  function create({ type, note, photo = null, orderId = null, driverId = null, reporter = 'admin' }) {
    if (!INCIDENT_TYPES[type]) throw new AppError(`Type must be one of: ${Object.keys(INCIDENT_TYPES).join(', ')}`);
    const body = text(note, 1000, 'A note', { required: true });
    let order = null;
    if (orderId != null) { order = orders.byId(orderId); if (!order) throw new AppError('That order does not exist', 404, 'not_found'); }
    const driver = driverId ?? order?.driver_id ?? (reporter.startsWith('driver:') ? reporter.slice(7) : null);
    if (!order && !driver) throw new AppError('Choose the order or the driver this is about');
    const r = q.run(db, 'INSERT INTO incidents(at,reporter,type,note,photo,order_id,driver_id) VALUES(?,?,?,?,?,?,?)', iso(), reporter, type, body, photo, order?.id ?? null, driver);
    const id = Number(r.lastInsertRowid);
    if (order) orders.event(order.id, 'incident', { id, type });
    audit.log(reporter, 'incident.create', 'incident', id, { type, order: order?.number ?? null, driver, note: body, photo });
    ctx.bus.emit('board', { incidents: true });
    return view(get(id));
  }

  function resolve(id, { note = null, actor = 'admin' } = {}) {
    const i = get(id);
    if (!i) throw new AppError('That incident does not exist', 404, 'not_found');
    if (i.status === 'resolved') return view(i);
    q.run(db, "UPDATE incidents SET status = 'resolved', resolved_at = ?, resolved_note = ? WHERE id = ?", iso(), text(note, 500, 'note'), id);
    audit.log(actor, 'incident.resolve', 'incident', id, { type: i.type });
    return view(get(id));
  }

  function view(i) {
    const o = i.order_id ? q.get(db, 'SELECT number FROM orders WHERE id = ?', i.order_id) : null;
    const d = i.driver_id ? q.get(db, 'SELECT MAX(driver_name) AS n FROM driver_shifts WHERE driver_id = ?', i.driver_id)?.n : null;
    return { ...i, type_label: INCIDENT_TYPES[i.type] ?? i.type, order_number: o?.number ?? null, driver_name: d ?? null };
  }

  function list({ from, to, status, type, orderId, driverId, limit = 500 } = {}) {
    const rows = q.all(db, `SELECT * FROM incidents WHERE (?1 IS NULL OR at >= ?1) AND (?2 IS NULL OR at < ?2) AND (?3 IS NULL OR status = ?3) AND (?4 IS NULL OR type = ?4)
      AND (?5 IS NULL OR order_id = ?5) AND (?6 IS NULL OR driver_id = ?6) ORDER BY id DESC LIMIT ?7`, from ?? null, to ?? null, status ?? null, type ?? null, orderId ?? null, driverId ?? null, limit);
    return rows.map(view);
  }

  function csv(filter = {}) {
    const head = ['id', 'at', 'reported_by', 'type', 'order', 'driver', 'note', 'photo', 'status', 'resolved_at', 'resolved_note'];
    const lines = list({ ...filter, limit: 10000 }).reverse().map((i) => [i.id, i.at, i.reporter, i.type_label, i.order_number, i.driver_name ?? i.driver_id, i.note, i.photo, i.status, i.resolved_at, i.resolved_note].map(csvCell).join(','));
    return [head.join(','), ...lines].join('\n') + '\n';
  }

  return { create, resolve, list, csv, get: (id) => { const i = get(id); return i ? view(i) : null; } };
}
