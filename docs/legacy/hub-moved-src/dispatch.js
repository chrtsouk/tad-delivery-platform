/**
 * Delivery dispatch (owner note 18): the hub the driver app, the customer's tracking page and the own-website ordering
 * system plug into. Those are separate projects; this is the shared core they talk to, over `/api/v1`.
 *
 *   customer   a person who orders from the kitchen directly (never a delivery-platform customer: those hide theirs).
 *              Personal data — it can be erased, is kept out of the analytics copy, and is shown only to people who dispatch.
 *   driver     name, phone, the most items they take on one run (blank = no limit: the owner's number, never invented),
 *              a key for the driver app (shown once, kept as a SHA-256 fingerprint) and the last place they reported.
 *   delivery   one drop: where, how many items, for whom, which kitchen order it is, who has it, and where it stands.
 *
 *   waiting ──assign──▶ assigned ──out──▶ out ──▶ delivered
 *      ▲  ▲                 │              └────▶ failed (a reason is required) ──requeue──▶ waiting
 *      │  └────unassign─────┘     any open state, or failed ──▶ cancelled (a reason is required)
 *      └──────────────────────────────────────────────────────────────────────────┘
 *
 * Grouping a run by postcode: the app has no map and calls no geocoder (free, local), so "near" means the postcode's outward
 * code — SW11 with SW11, then SW12 / SW10 (same letters, next number), then anywhere else. That is a rule of thumb, said so on
 * the screen; the dispatcher can always move a drop by hand.
 *
 * The kitchen link: a delivery made from a kitchen order marks that order bumped when the driver leaves with it.
 */
import crypto from 'node:crypto';
import db from '../db/index.js';
import repo from './repo.js';
import sites from './sites.js';
import settings from './settings.js';
import clock from './clock.js';
import kitchen from './kitchen.js';
import { AppError, toNum } from './util.js';

export const STATUSES = ['waiting', 'assigned', 'out', 'delivered', 'failed', 'cancelled'];
const OPEN = ['waiting', 'assigned', 'out'];
export const MESSAGE_FROM = ['office', 'driver', 'customer'];

const iso = () => clock.now().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const minutesBetween = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000));

/* ---------------------------------------------------------------- cleaning */

/** A UK postcode as it should be written ("sw11 1ab" → "SW11 1AB"), or an error in plain words. */
export function normalisePostcode(pc) {
  const raw = String(pc ?? '').toUpperCase().replace(/\s+/g, '');
  const m = /^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/.exec(raw);
  if (!m) throw new AppError(`"${String(pc ?? '').trim()}" does not look like a UK postcode (for example SW11 1AB)`);
  return { postcode: `${m[1]} ${m[2]}`, area: m[1] };
}

function cleanPhone(p) {
  if (p === undefined || p === null || String(p).trim() === '') return null;
  const t = String(p).replace(/[\s()-]/g, '');
  if (!/^\+?\d{7,15}$/.test(t)) throw new AppError(`"${String(p).trim()}" does not look like a phone number`);
  return t;
}

function cleanEmail(e) {
  if (e === undefined || e === null || String(e).trim() === '') return null;
  const t = String(e).trim().toLowerCase();
  if (t.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) throw new AppError(`"${String(e).trim()}" does not look like an email address`);
  return t;
}

const text = (v, max, what, { required = false } = {}) => {
  const t = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!t) { if (required) throw new AppError(`${what} is needed`); return null; }
  if (t.length > max) throw new AppError(`${what} is too long (${max} characters at most)`);
  return t;
};

function whole(v, what, { min = 1, max = 500, blank = null } = {}) {
  if (v === undefined || v === null || v === '') return blank;
  const n = toNum(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new AppError(`${what} must be a whole number from ${min} to ${max}`);
  return n;
}

/* --------------------------------------------------------------- customers */

function customerRow(c) {
  return {
    id: c.id, name: c.name, phone: c.phone, email: c.email, address: c.address, postcode: c.postcode, note: c.note,
    marketing_ok: !!c.marketing_ok, erased: !!c.erased_at,
  };
}

export function saveCustomer(data = {}, { user = 'owner' } = {}) {
  const pc = data.postcode ? normalisePostcode(data.postcode) : null;
  const row = {
    name: text(data.name, 80, 'The name', { required: true }),
    phone: cleanPhone(data.phone),
    email: cleanEmail(data.email),
    address: text(data.address, 200, 'The address'),
    postcode: pc ? pc.postcode : null,
    note: text(data.note, 300, 'The note'),
    marketing_ok: data.marketing_ok ? 1 : 0,
  };
  if (data.id) {
    const was = repo.byId('customers', data.id);
    if (!was || was.deleted_at) throw new AppError('That customer is not here', 404);
    if (was.erased_at) throw new AppError('That customer was erased at their request and cannot be changed', 409);
    return customerRow(repo.update('customers', data.id, row, { user, entity: 'customer' }));
  }
  if (row.phone) {
    const dup = db.get('SELECT * FROM customers WHERE phone = ? AND erased_at IS NULL AND deleted_at IS NULL', [row.phone]);
    if (dup) throw new AppError(`${dup.name} already has that phone number`, 409);
  }
  return customerRow(repo.insert('customers', row, { user, entity: 'customer' }));
}

export function customers({ q, limit = 100 } = {}) {
  const where = ['deleted_at IS NULL', 'erased_at IS NULL'];
  const params = [];
  if (q && String(q).trim()) {
    const like = `%${String(q).trim().replace(/[%_]/g, '')}%`;
    where.push('(name LIKE ? OR phone LIKE ? OR postcode LIKE ?)');
    params.push(like, like, like);
  }
  return db.all(`SELECT * FROM customers WHERE ${where.join(' AND ')} ORDER BY name LIMIT ?`, [...params, limit]).map(customerRow);
}

/**
 * A person asks to be forgotten (UK GDPR): their name, phone, email, address and notes are blanked here and on every delivery
 * made to them. The deliveries stay (the area and the times are the kitchen's own records), the person does not.
 */
export function eraseCustomer(id, { user = 'owner' } = {}) {
  const c = repo.byId('customers', id);
  if (!c || c.deleted_at) throw new AppError('That customer is not here', 404);
  return db.tx(() => {
    repo.update('customers', id, { name: 'Erased customer', phone: null, email: null, address: null, postcode: null, note: null, marketing_ok: 0, erased_at: iso() },
      { user, entity: 'customer', note: 'erased at the customer\'s request' });
    for (const d of db.all('SELECT id FROM deliveries WHERE customer_id = ?', [id])) {
      repo.update('deliveries', d.id, { recipient: null, phone: null, address: null, postcode: null, note: null }, { user, entity: 'delivery', log: false });
      // through the repository, so the other copy of the app sees the change and blanks them too
      for (const m of db.all('SELECT id FROM delivery_messages WHERE delivery_id = ?', [d.id])) {
        repo.update('delivery_messages', m.id, { body: '(erased)', from_name: null }, { user, entity: 'delivery_message', log: false });
      }
    }
    return { ok: true };
  });
}

/* ----------------------------------------------------------------- drivers */

const DRIVER_TOKEN_PREFIX = 'drv_';

function driverLoad(id) {
  return db.value("SELECT COALESCE(SUM(items), 0) FROM deliveries WHERE driver_id = ? AND status IN ('assigned','out') AND deleted_at IS NULL", [id]) || 0;
}

function describeDriver(d) {
  const load = driverLoad(d.id);
  const out = db.value("SELECT COUNT(*) FROM deliveries WHERE driver_id = ? AND status = 'out' AND deleted_at IS NULL", [d.id]) || 0;
  const loaded = db.value("SELECT COUNT(*) FROM deliveries WHERE driver_id = ? AND status = 'assigned' AND deleted_at IS NULL", [d.id]) || 0;
  return {
    id: d.id, name: d.name, phone: d.phone, vehicle: d.vehicle, max_items: d.max_items, active: !!d.active,
    has_key: !!d.token_hash,
    state: !d.active ? 'off' : out ? 'on_run' : loaded ? 'loaded' : 'free',
    load_items: load, room: d.max_items === null || d.max_items === undefined ? null : Math.max(0, d.max_items - load),
    drops_out: out, drops_loaded: loaded,
    last_seen_at: d.last_seen_at, last_lat: d.last_lat, last_lng: d.last_lng,
  };
}

export function saveDriver(data = {}, { user = 'owner' } = {}) {
  const row = {
    name: text(data.name, 60, 'The driver\'s name', { required: true }),
    phone: cleanPhone(data.phone),
    vehicle: text(data.vehicle, 40, 'The vehicle'),
    max_items: whole(data.max_items, 'The most items on a run', { min: 1, max: 200 }),
  };
  if (data.active !== undefined) row.active = data.active ? 1 : 0;
  if (data.id) {
    const was = repo.byId('drivers', data.id);
    if (!was || was.deleted_at) throw new AppError('That driver is not here', 404);
    if (row.active === 0 && was.active) {
      const busy = db.value("SELECT COUNT(*) FROM deliveries WHERE driver_id = ? AND status IN ('assigned','out') AND deleted_at IS NULL", [data.id]) || 0;
      if (busy) throw new AppError(`${was.name} still has ${busy} drop(s). Move or finish them first.`, 409);
    }
    return describeDriver(repo.update('drivers', data.id, row, { user, entity: 'driver' }));
  }
  if (db.get('SELECT 1 AS x FROM drivers WHERE lower(name) = lower(?) AND deleted_at IS NULL', [row.name])) {
    throw new AppError(`There is already a driver called ${row.name}`, 409);
  }
  return describeDriver(repo.insert('drivers', { active: 1, ...row }, { user, entity: 'driver' }));
}

export function drivers({ includeInactive = true } = {}) {
  return db.all(`SELECT * FROM drivers WHERE deleted_at IS NULL ${includeInactive ? '' : 'AND active = 1'} ORDER BY active DESC, name`).map(describeDriver);
}

/** A new key for the driver app. Shown once; any older key stops working at once. */
export function newDriverKey(id, { user = 'owner' } = {}) {
  const d = repo.byId('drivers', id);
  if (!d || d.deleted_at) throw new AppError('That driver is not here', 404);
  const key = DRIVER_TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
  repo.update('drivers', id, { token_hash: sha(key) }, { user, entity: 'driver', note: 'new driver-app key' });
  return { key, note: 'Copy this now: it is not shown again.' };
}

export function revokeDriverKey(id, { user = 'owner' } = {}) {
  const d = repo.byId('drivers', id);
  if (!d || d.deleted_at) throw new AppError('That driver is not here', 404);
  repo.update('drivers', id, { token_hash: null }, { user, entity: 'driver', note: 'driver-app key revoked' });
  return describeDriver(repo.byId('drivers', id));
}

/** Who a driver-app key belongs to, or null. */
export function authenticateDriver(key) {
  if (!key || !String(key).startsWith(DRIVER_TOKEN_PREFIX) || key.length > 200) return null;
  const d = db.get('SELECT * FROM drivers WHERE token_hash = ? AND active = 1 AND deleted_at IS NULL', [sha(String(key))]);
  return d || null;
}

/** The driver app reports where it is. Only the last place is kept (it is not a trail). */
export function ping(driverId, { lat, lng } = {}) {
  const a = toNum(lat); const o = toNum(lng);
  if (!Number.isFinite(a) || !Number.isFinite(o) || a < -90 || a > 90 || o < -180 || o > 180) throw new AppError('That is not a place on Earth: send lat (−90 to 90) and lng (−180 to 180)');
  repo.update('drivers', driverId, { last_lat: Math.round(a * 1e6) / 1e6, last_lng: Math.round(o * 1e6) / 1e6, last_seen_at: iso() }, { user: 'driver app', entity: 'driver', log: false });
  return { ok: true };
}

/* -------------------------------------------------------------- deliveries */

const newToken = () => crypto.randomBytes(18).toString('base64url');

function itemsOfOrder(orderId) {
  const n = db.value('SELECT COALESCE(SUM(qty), 0) FROM kitchen_order_lines WHERE order_id = ? AND deleted_at IS NULL', [orderId]) || 0;
  return Math.max(1, Math.ceil(n));
}

function describe(d, now = iso()) {
  const drv = d.driver_id ? repo.byId('drivers', d.driver_id) : null;
  const order = d.kitchen_order_id ? repo.byId('kitchen_orders', d.kitchen_order_id) : null;
  const unread = db.value("SELECT COUNT(*) FROM delivery_messages WHERE delivery_id = ? AND from_kind != 'office' AND read_at IS NULL AND deleted_at IS NULL", [d.id]) || 0;
  const open = OPEN.includes(d.status);
  return {
    id: d.id, site_id: d.site_id, status: d.status, kitchen_order_id: d.kitchen_order_id, order_number: order ? order.number : null,
    customer_id: d.customer_id, recipient: d.recipient, phone: d.phone, address: d.address, postcode: d.postcode, area: d.area,
    items: d.items, driver_id: d.driver_id, driver_name: drv ? drv.name : null, note: d.note,
    placed_at: d.placed_at, promised_at: d.promised_at, assigned_at: d.assigned_at, out_at: d.out_at, delivered_at: d.delivered_at,
    failed_reason: d.failed_reason,
    waiting_minutes: open ? minutesBetween(d.placed_at, now) : null,
    late_for_promise: open && d.promised_at ? Date.parse(now) > Date.parse(d.promised_at) : false,
    took_minutes: d.delivered_at ? minutesBetween(d.placed_at, d.delivered_at) : null,
    unread_messages: unread,
  };
}

function deliveryOrThrow(id) {
  const d = repo.byId('deliveries', id);
  if (!d || d.deleted_at) throw new AppError('That delivery is not here', 404);
  return d;
}

export const get = (id) => describe(deliveryOrThrow(id));

/**
 * Make a delivery. From a kitchen order (`kitchen_order_id`: the items are counted from it, and it can only have one live
 * delivery), or on its own. The customer can be a saved one (`customer_id`) or typed here; `remember: true` saves a typed one.
 */
export function create(data = {}, { user = 'owner' } = {}) {
  const site = sites.resolve(data.site_id);
  let order = null;
  if (data.kitchen_order_id) {
    order = repo.byId('kitchen_orders', data.kitchen_order_id);
    if (!order || order.deleted_at) throw new AppError('That kitchen order is not here', 404);
    if (order.site_id !== site) throw new AppError('That kitchen order belongs to another site', 409);
    if (order.status === 'cancelled') throw new AppError('That kitchen order was cancelled', 409);
    // a failed or cancelled delivery does not stop the order being delivered again
    const dup = db.get("SELECT id FROM deliveries WHERE kitchen_order_id = ? AND status NOT IN ('cancelled','failed') AND deleted_at IS NULL", [order.id]);
    if (dup) return { ...get(dup.id), duplicate: true };
  }
  let c = null;
  if (data.customer_id) {
    c = repo.byId('customers', data.customer_id);
    if (!c || c.deleted_at) throw new AppError('That customer is not here', 404);
    if (c.erased_at) throw new AppError('That customer was erased and cannot be delivered to', 409);
  }
  const addr = text(data.address ?? c?.address, 200, 'The address', { required: true });
  const pc = normalisePostcode(data.postcode ?? c?.postcode);
  const recipient = text(data.recipient ?? c?.name, 80, 'Who it is for', { required: true });
  const phone = cleanPhone(data.phone ?? c?.phone);
  const items = data.items !== undefined && data.items !== null && data.items !== ''
    ? whole(data.items, 'The number of items', { min: 1, max: 200 })
    : order ? itemsOfOrder(order.id) : 1;
  if (data.promised_at && Number.isNaN(Date.parse(data.promised_at))) throw new AppError('The promised time is not a time');
  return db.tx(() => {
    if (!c && data.remember && phone) {
      c = db.get('SELECT * FROM customers WHERE phone = ? AND erased_at IS NULL AND deleted_at IS NULL', [phone]);
      if (!c) {
        const made = saveCustomer({ name: recipient, phone, address: addr, postcode: pc.postcode, email: data.email, marketing_ok: data.marketing_ok }, { user });
        c = { id: made.id };
      }
    }
    const row = repo.insert('deliveries', {
      site_id: site, kitchen_order_id: order ? order.id : null, customer_id: c ? c.id : null,
      recipient, phone, address: addr, postcode: pc.postcode, area: pc.area, items, status: 'waiting', driver_id: null,
      tracking_token: newToken(), note: text(data.note, 300, 'The note'),
      placed_at: order ? order.placed_at : iso(), promised_at: data.promised_at ? new Date(data.promised_at).toISOString() : (order ? order.due_at : null),
    }, { user, entity: 'delivery', site_id: site });
    return { ...describe(row), duplicate: false };
  });
}

function move(id, from, to, patch, user, note) {
  const d = deliveryOrThrow(id);
  if (!from.includes(d.status)) throw new AppError(`That delivery is ${d.status}, so it cannot go to ${to}`, 409);
  repo.update('deliveries', id, { status: to, ...patch }, { user, entity: 'delivery', note: note || `${d.status} → ${to}` });
  return get(id);
}

const settingMax = (drv) => (drv.max_items === null || drv.max_items === undefined ? Infinity : drv.max_items);

/** Give drops to a driver. Over their limit is refused unless the dispatcher says so (`allow_over`). */
export function assign(driverId, deliveryIds, { allow_over = false, user = 'owner' } = {}) {
  const drv = repo.byId('drivers', driverId);
  if (!drv || drv.deleted_at) throw new AppError('That driver is not here', 404);
  if (!drv.active) throw new AppError(`${drv.name} is not working`, 409);
  const ids = [...new Set(deliveryIds || [])];
  if (!ids.length) throw new AppError('Pick at least one delivery');
  const ds = ids.map(deliveryOrThrow);
  for (const d of ds) {
    if (d.status !== 'waiting') throw new AppError(`The delivery to ${d.recipient || d.postcode} is ${d.status}; only waiting ones can be given out`, 409);
    if (d.site_id !== ds[0].site_id) throw new AppError('Those deliveries are at different sites', 409);
  }
  const add = ds.reduce((a, d) => a + d.items, 0);
  const total = driverLoad(driverId) + add;
  if (!allow_over && total > settingMax(drv)) {
    throw new AppError(`${drv.name} takes ${drv.max_items} items at most and would have ${total}. Give some to someone else, or confirm to send them anyway.`, 409, { over: true, total, max: drv.max_items });
  }
  return db.tx(() => {
    for (const d of ds) repo.update('deliveries', d.id, { status: 'assigned', driver_id: driverId, assigned_at: iso() }, { user, entity: 'delivery', note: `waiting → assigned (${drv.name})` });
    return ds.map((d) => get(d.id));
  });
}

export const unassign = (id, { user = 'owner' } = {}) => move(id, ['assigned'], 'waiting', { driver_id: null, assigned_at: null }, user, 'assigned → waiting');

/** The driver leaves with these drops (all of theirs that are loaded when none are named). Marks the kitchen orders bumped. */
export function sendOut(driverId, deliveryIds = null, { user = 'owner' } = {}) {
  const drv = repo.byId('drivers', driverId);
  if (!drv || drv.deleted_at) throw new AppError('That driver is not here', 404);
  const rows = deliveryIds && deliveryIds.length
    ? deliveryIds.map(deliveryOrThrow)
    : db.all("SELECT * FROM deliveries WHERE driver_id = ? AND status = 'assigned' AND deleted_at IS NULL ORDER BY assigned_at", [driverId]);
  if (!rows.length) throw new AppError(`${drv.name} has nothing loaded`, 409);
  for (const d of rows) {
    if (d.driver_id !== driverId || d.status !== 'assigned') throw new AppError(`The delivery to ${d.recipient || d.postcode} is not loaded on ${drv.name}`, 409);
  }
  return db.tx(() => {
    const at = iso();
    for (const d of rows) {
      repo.update('deliveries', d.id, { status: 'out', out_at: at }, { user, entity: 'delivery', note: `assigned → out (${drv.name})` });
      if (d.kitchen_order_id) {
        const o = repo.byId('kitchen_orders', d.kitchen_order_id);
        if (o && ['new', 'cooking', 'ready'].includes(o.status)) kitchen.bump(o.id, { user });
      }
    }
    return rows.map((d) => get(d.id));
  });
}

export const markDelivered = (id, { user = 'owner' } = {}) => move(id, ['out'], 'delivered', { delivered_at: iso() }, user, 'out → delivered');

export function markFailed(id, { reason, user = 'owner' } = {}) {
  const why = text(reason, 200, 'The reason', { required: false });
  if (!why || why.length < 3) throw new AppError('Say why it could not be delivered');
  return move(id, ['assigned', 'out'], 'failed', { failed_reason: why }, user, `failed: ${why}`);
}

/** A drop that could not be delivered goes back on the board to try again (a different driver, another day). */
export const requeue = (id, { user = 'owner' } = {}) => move(id, ['failed'], 'waiting',
  { driver_id: null, assigned_at: null, out_at: null, failed_reason: null }, user, 'failed → waiting (tried again)');

export function cancel(id, { reason, user = 'owner' } = {}) {
  const why = text(reason, 200, 'The reason');
  if (!why || why.length < 3) throw new AppError('Say why it is cancelled');
  return move(id, [...OPEN, 'failed'], 'cancelled', { failed_reason: why, driver_id: null }, user, `cancelled: ${why}`);
}

/** The drops loaded on a driver and not yet out. */
export const loadedIds = (driverId) => db.all("SELECT id FROM deliveries WHERE driver_id = ? AND status = 'assigned' AND deleted_at IS NULL", [driverId]).map((r) => r.id);

/** The dispatcher's board: what is waiting, who has what, and tonight's results. */
export function board({ site_id } = {}) {
  const site = sites.resolve(site_id);
  const now = iso();
  const open = db.all("SELECT * FROM deliveries WHERE site_id = ? AND status IN ('waiting','assigned','out') AND deleted_at IS NULL ORDER BY placed_at", [site]).map((d) => describe(d, now));
  const day = clock.dateOf(new Date(now), site);
  const closedAt = (d) => d.delivered_at || d.updated_at || d.placed_at;
  const finished = db.all("SELECT * FROM deliveries WHERE site_id = ? AND status IN ('delivered','failed','cancelled') AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 80", [site]);
  const closed = finished.filter((d) => d.status !== 'failed' && clock.dateOf(new Date(closedAt(d)), site) === day).map((d) => describe(d, now));
  // a drop that could not be delivered stays in view, from any day, until someone puts it back or cancels it
  const failed = finished.filter((d) => d.status === 'failed').map((d) => describe(d, now));
  const took = closed.filter((d) => d.took_minutes !== null).map((d) => d.took_minutes).sort((a, b) => a - b);
  return {
    now, site_id: site, trading_day: day,
    waiting: open.filter((d) => d.status === 'waiting'),
    assigned: open.filter((d) => d.status === 'assigned'),
    out: open.filter((d) => d.status === 'out'),
    failed,
    closed_tonight: closed,
    delivered_tonight: closed.filter((d) => d.status === 'delivered').length,
    failed_tonight: finished.filter((d) => d.status === 'failed' && clock.dateOf(new Date(closedAt(d)), site) === day).length,
    median_minutes: took.length ? took[Math.floor((took.length - 1) / 2)] : null,
    drivers: drivers({ includeInactive: false }),
  };
}

/* -------------------------------------------------------------- suggestions */

function areaDistance(a, b) {
  if (a === b) return 0;
  const pa = /^([A-Z]{1,2})(\d+)/.exec(a); const pb = /^([A-Z]{1,2})(\d+)/.exec(b);
  if (pa && pb && pa[1] === pb[1]) return 1 + Math.abs(Number(pa[2]) - Number(pb[2]));
  return 100;
}

/**
 * A suggested way to hand out what is waiting. It changes nothing. The oldest waiting drop starts a run (food goes cold),
 * then the nearest postcodes join it until the driver's limit; drivers with the most room go first. A drop bigger than a
 * limit on its own goes alone and is marked `over`. What nobody has room for is returned as `left`.
 */
export function suggest({ site_id } = {}) {
  const site = sites.resolve(site_id);
  const waiting = db.all("SELECT * FROM deliveries WHERE site_id = ? AND status = 'waiting' AND deleted_at IS NULL ORDER BY placed_at", [site]);
  let pool = waiting.map((d) => ({ id: d.id, area: d.area, items: d.items, recipient: d.recipient, postcode: d.postcode, placed_at: d.placed_at }));
  const free = drivers({ includeInactive: false })
    .map((d) => ({ ...d, left: d.room === null ? Infinity : d.room }))
    .sort((a, b) => b.left - a.left || a.load_items - b.load_items);
  const runs = [];
  for (const drv of free) {
    if (!pool.length) break;
    if (drv.left <= 0) continue;
    let seedIdx = pool.findIndex((d) => d.items <= drv.left);
    let over = false;
    if (seedIdx < 0) {
      // nothing fits the room this driver has; if they carry nothing at all, the oldest goes alone (over their limit)
      if (drv.load_items === 0 && drv.max_items !== null) { seedIdx = 0; over = true; } else continue;
    }
    const seed = pool[seedIdx];
    const run = [seed];
    let room = drv.left - seed.items;
    const rest = pool.filter((d) => d !== seed).sort((a, b) => areaDistance(seed.area, a.area) - areaDistance(seed.area, b.area) || (a.placed_at < b.placed_at ? -1 : 1));
    if (!over) {
      for (const d of rest) {
        if (areaDistance(seed.area, d.area) >= 100 && run.length) continue;   // a different part of town is a different run
        if (d.items <= room) { run.push(d); room -= d.items; }
      }
    }
    pool = pool.filter((d) => !run.includes(d));
    runs.push({
      driver_id: drv.id, driver_name: drv.name, delivery_ids: run.map((d) => d.id), items: run.reduce((a, d) => a + d.items, 0),
      areas: [...new Set(run.map((d) => d.area))], over,
      stops: run.map((d) => ({ id: d.id, recipient: d.recipient, postcode: d.postcode, items: d.items })),
    });
  }
  return {
    site_id: site, runs, left: pool,
    note: 'Near means the same postcode area, then the next district of the same letters. There is no map behind this: move a drop by hand if you know better.',
  };
}

/* ------------------------------------------------------------ driver's side */

/** What a driver sees: their own drops, with the address and the phone to call. Nothing else about anyone. */
export function driverRun(driver) {
  const rows = db.all("SELECT * FROM deliveries WHERE driver_id = ? AND status IN ('assigned','out') AND deleted_at IS NULL ORDER BY COALESCE(out_at, assigned_at)", [driver.id]);
  return {
    driver: { id: driver.id, name: driver.name, max_items: driver.max_items },
    deliveries: rows.map((d) => {
      const x = describe(d);
      return {
        id: x.id, status: x.status, recipient: x.recipient, phone: x.phone, address: x.address, postcode: x.postcode, items: x.items,
        note: x.note, promised_at: x.promised_at, order_number: x.order_number, unread_messages: x.unread_messages,
      };
    }),
  };
}

function ownDelivery(driver, id) {
  const d = deliveryOrThrow(id);
  if (d.driver_id !== driver.id) throw new AppError('That drop is not on your run', 403);
  return d;
}

/** The driver app moves one of its own drops: out, delivered or failed (with a reason). */
export function driverSetStatus(driver, id, status, { reason } = {}) {
  ownDelivery(driver, id);
  const user = `driver:${driver.name}`;
  if (status === 'out') return sendOut(driver.id, [id], { user })[0];
  if (status === 'delivered') return markDelivered(id, { user });
  if (status === 'failed') return markFailed(id, { reason, user });
  throw new AppError('A driver can set a drop to out, delivered or failed');
}

/* ------------------------------------------------------------------ messages */

/**
 * One thread per delivery. A message from the office or the driver is for the team only unless it says `audience: 'all'`,
 * so a note between them ("he never answers the door") can never reach the customer's page by default. What a customer
 * writes is seen by everyone.
 */
export function addMessage(deliveryId, { from_kind, from_name, body, audience } = {}) {
  deliveryOrThrow(deliveryId);
  if (!MESSAGE_FROM.includes(from_kind)) throw new AppError('Who is this message from?');
  if (audience !== undefined && audience !== null && !['team', 'all'].includes(audience)) throw new AppError('Who is it for: the team, or all (the customer too)?');
  const t = text(body, 300, 'The message', { required: true });
  const aud = from_kind === 'customer' ? 'all' : (audience || 'team');
  const row = repo.insert('delivery_messages', { delivery_id: deliveryId, from_kind, from_name: text(from_name, 60, 'The name'), body: t, audience: aud },
    { user: from_name || from_kind, entity: 'delivery_message', log: false });
  return { id: row.id, from_kind: row.from_kind, from_name: row.from_name, body: row.body, audience: row.audience, at: row.created_at };
}

export function messages(deliveryId, { markRead = false, reader = 'office', forCustomer = false } = {}) {
  deliveryOrThrow(deliveryId);
  const rows = db.all(`SELECT * FROM delivery_messages WHERE delivery_id = ? AND deleted_at IS NULL ${forCustomer ? "AND audience = 'all'" : ''} ORDER BY created_at, rowid`, [deliveryId]);
  if (markRead) db.run("UPDATE delivery_messages SET read_at = ?, updated_at = ? WHERE delivery_id = ? AND from_kind != ? AND read_at IS NULL", [iso(), iso(), deliveryId, reader]);
  return rows.map((m) => ({ id: m.id, from_kind: m.from_kind, from_name: m.from_name, body: m.body, audience: m.audience, at: m.created_at }));
}

/* ------------------------------------------------------------------ tracking */

/**
 * What a customer may see through their tracking link: where their order stands, who is bringing it (first name only), and
 * where the driver last said they were while the order is on its way. No address, phone or other customers. Off until the owner
 * switches it on (Settings → tracking_enabled); an unknown link and a switched-off one look the same.
 */
export function tracking(token) {
  if (!settings.get('tracking_enabled')) return null;
  if (!token || String(token).length > 64 || !/^[A-Za-z0-9_-]+$/.test(String(token))) return null;
  const d = db.get('SELECT * FROM deliveries WHERE tracking_token = ? AND deleted_at IS NULL', [String(token)]);
  if (!d) return null;
  const drv = d.driver_id ? repo.byId('drivers', d.driver_id) : null;
  const now = iso();
  const onTheWay = d.status === 'out' && drv && drv.last_lat !== null && drv.last_lat !== undefined;
  const site = sites.byId(d.site_id);
  return {
    status: d.status,
    steps: ['waiting', 'assigned', 'out', 'delivered'],
    kitchen: site ? site.name : null,
    items: d.items,
    driver: drv && ['assigned', 'out'].includes(d.status) ? drv.name.split(' ')[0] : null,
    promised_at: d.promised_at,
    out_at: d.out_at,
    delivered_at: d.delivered_at,
    problem: d.status === 'failed' || d.status === 'cancelled',
    position: onTheWay ? { lat: drv.last_lat, lng: drv.last_lng, seen_minutes_ago: minutesBetween(drv.last_seen_at, now) } : null,
    messages: messages(d.id, { forCustomer: true }).map((m) => ({ from: m.from_kind, body: m.body, at: m.at })),
  };
}

export function trackingMessage(token, body) {
  if (!tracking(token)) return null;
  const d = db.get('SELECT * FROM deliveries WHERE tracking_token = ? AND deleted_at IS NULL', [String(token)]);
  if (!OPEN.includes(d.status)) throw new AppError('This order is finished, so it cannot take new messages', 409);
  const recent = db.value("SELECT COUNT(*) FROM delivery_messages WHERE delivery_id = ? AND from_kind = 'customer' AND created_at > ?", [d.id, new Date(clock.now().getTime() - 10 * 60_000).toISOString()]) || 0;
  if (recent >= 5) throw new AppError('Please wait a few minutes before sending another message', 429);
  return addMessage(d.id, { from_kind: 'customer', from_name: d.recipient ? d.recipient.split(' ')[0] : 'Customer', body });
}

/** The link to give a customer: the path (the website adds its own address). */
export const trackingPath = (id) => `/track/${deliveryOrThrow(id).tracking_token}`;

export default {
  STATUSES, MESSAGE_FROM, normalisePostcode,
  saveCustomer, customers, eraseCustomer,
  saveDriver, drivers, newDriverKey, revokeDriverKey, authenticateDriver, ping,
  create, get, assign, unassign, sendOut, markDelivered, markFailed, requeue, cancel, loadedIds, board, suggest,
  driverRun, driverSetStatus, addMessage, messages, tracking, trackingMessage, trackingPath,
};
