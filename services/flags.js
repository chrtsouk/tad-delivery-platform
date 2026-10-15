/**
 * Problem customers / addresses. A phone number or an address can be flagged (a warning) or blocked (a new order is refused,
 * the admin can override on a manual order). Matching is on the normalised phone, or on postcode + the alphanumerics of line 1.
 */
import { q } from '../lib/db.js';
import { AppError, text } from '../lib/util.js';
import { normalisePhone, normalisePostcode } from '../lib/geo.js';

export const LEVELS = ['flagged', 'blocked'];

export function addressKey(line1, postcode) {
  const pc = normalisePostcode(postcode).postcode;
  const line = String(line1 ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!line) throw new AppError('The address line is needed');
  return `${pc}|${line}`;
}

export function createFlags(ctx) {
  const { db, now, audit } = ctx;
  const iso = () => now().toISOString();
  const active = () => q.all(db, 'SELECT * FROM customer_flags WHERE cleared_at IS NULL');

  function add({ kind, phone, line1, postcode, level, reason, actor = 'admin' }) {
    if (!['phone', 'address'].includes(kind)) throw new AppError('A flag is for a phone number or an address');
    if (!LEVELS.includes(level)) throw new AppError('Choose flagged or blocked');
    const why = text(reason, 300, 'A reason', { required: true });
    let key, label;
    if (kind === 'phone') {
      key = normalisePhone(phone);
      if (!key) throw new AppError('A phone number is needed');
      label = key;
    } else {
      key = addressKey(line1, postcode);
      label = `${text(line1, 160, 'address', { required: true })}, ${normalisePostcode(postcode).postcode}`;
    }
    const existing = q.get(db, 'SELECT id FROM customer_flags WHERE kind = ? AND value_key = ? AND cleared_at IS NULL', kind, key);
    let id;
    if (existing) { q.run(db, 'UPDATE customer_flags SET level = ?, reason = ? WHERE id = ?', level, why, existing.id); id = existing.id; }
    else id = Number(q.run(db, 'INSERT INTO customer_flags(kind,value_key,label,level,reason,created_at,created_by) VALUES(?,?,?,?,?,?,?)', kind, key, label, level, why, iso(), actor).lastInsertRowid);
    audit.log(actor, existing ? 'flag.update' : 'flag.add', 'customer_flag', id, { kind, label, level, reason: why });
    ctx.bus.emit('board', { flags: true });
    return get(id);
  }

  const get = (id) => q.get(db, 'SELECT * FROM customer_flags WHERE id = ?', id);

  function clear(id, { actor = 'admin' } = {}) {
    const f = get(id);
    if (!f) throw new AppError('That flag does not exist', 404, 'not_found');
    if (f.cleared_at) return f;
    q.run(db, 'UPDATE customer_flags SET cleared_at = ?, cleared_by = ? WHERE id = ?', iso(), actor, id);
    audit.log(actor, 'flag.clear', 'customer_flag', id, { kind: f.kind, label: f.label });
    ctx.bus.emit('board', { flags: true });
    return get(id);
  }

  const list = ({ includeCleared = false } = {}) => q.all(db, `SELECT * FROM customer_flags ${includeCleared ? '' : 'WHERE cleared_at IS NULL'} ORDER BY (level = 'blocked') DESC, id DESC`);

  /** Keys for one order/lookup; anything that cannot be normalised simply cannot match. */
  function keysOf({ phone, line1, postcode }) {
    const keys = [];
    try { const p = normalisePhone(phone); if (p) keys.push(['phone', p]); } catch { /* not a phone */ }
    try { if (line1 && postcode) keys.push(['address', addressKey(line1, postcode)]); } catch { /* not an address */ }
    return keys;
  }

  function matchIn(rows, who) {
    const keys = keysOf(who);
    const hits = rows.filter((f) => keys.some(([k, v]) => f.kind === k && f.value_key === v));
    return { level: hits.some((h) => h.level === 'blocked') ? 'blocked' : hits.length ? 'flagged' : null, matches: hits.map((h) => ({ id: h.id, kind: h.kind, level: h.level, reason: h.reason, label: h.label })) };
  }

  const check = (who) => matchIn(active(), who);

  /** One query for a whole board of orders. */
  function forOrders(orders) {
    const rows = active();
    if (!rows.length) return new Map();
    const out = new Map();
    for (const o of orders) { const m = matchIn(rows, { phone: o.customer_phone, line1: o.address_line, postcode: o.postcode }); if (m.level) out.set(o.id, { level: m.level, reasons: m.matches.map((x) => x.reason) }); }
    return out;
  }

  return { add, clear, list, check, forOrders, get };
}
