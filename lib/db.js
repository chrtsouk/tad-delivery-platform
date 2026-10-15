import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  site_id TEXT NOT NULL DEFAULT 'main',
  source TEXT NOT NULL,
  external_id TEXT,
  fulfilment TEXT NOT NULL DEFAULT 'delivery',
  state TEXT NOT NULL DEFAULT 'new',
  customer_name TEXT, customer_phone TEXT, customer_email TEXT,
  address_line TEXT, postcode TEXT, outcode TEXT, lat REAL, lng REAL,
  items_json TEXT NOT NULL DEFAULT '[]', item_count INTEGER NOT NULL DEFAULT 1,
  notes TEXT, total_pence INTEGER, delivery_fee_pence INTEGER, paid INTEGER NOT NULL DEFAULT 1,
  scheduled_for TEXT,
  created_at TEXT NOT NULL, accepted_at TEXT, ready_at TEXT, assigned_at TEXT, out_at TEXT, delivered_at TEXT,
  failed_at TEXT, cancelled_at TEXT,
  fleetbase_order_id TEXT, fleetbase_tracking TEXT,
  driver_id TEXT, batch_id INTEGER, stop_seq INTEGER,
  picked_at TEXT, fb_dropoff_place TEXT, fb_customer TEXT, track_token TEXT, fail_reason TEXT, fail_photo TEXT, hub_order_id TEXT, rating INTEGER,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS orders_state ON orders(state);
CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS orders_batch ON orders(batch_id);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS order_events_order ON order_events(order_id);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL DEFAULT 'main',
  driver_id TEXT,
  status TEXT NOT NULL,                 -- held | planned | assigned | out | done | cancelled
  preassigned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, assigned_at TEXT, out_at TEXT, done_at TEXT,
  return_eta_at TEXT, return_notified_at TEXT, note TEXT, route_json TEXT
);
CREATE INDEX IF NOT EXISTS batches_driver ON batches(driver_id, status);

CREATE TABLE IF NOT EXISTS driver_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id TEXT NOT NULL, driver_name TEXT,
  clock_in_at TEXT NOT NULL, clock_out_at TEXT, zone TEXT, site_id TEXT NOT NULL DEFAULT 'main'
);
CREATE INDEX IF NOT EXISTS shifts_driver ON driver_shifts(driver_id, clock_out_at);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON driver_shifts(driver_id) WHERE clock_out_at IS NULL;

CREATE TABLE IF NOT EXISTS driver_tokens (driver_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS customer_addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_norm TEXT NOT NULL, postcode TEXT NOT NULL,
  name TEXT, address_line TEXT NOT NULL, lat REAL, lng REAL,
  uses INTEGER NOT NULL DEFAULT 1, last_used_at TEXT NOT NULL,
  UNIQUE (phone_norm, postcode)
);
CREATE INDEX IF NOT EXISTS addr_phone ON customer_addresses(phone_norm);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, sub_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_ref ON push_subscriptions(kind, ref);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, target TEXT NOT NULL, channel TEXT NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT, read_at TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS notif_target ON notifications(target, read_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, entity TEXT, entity_id TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at);

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, postcode TEXT NOT NULL, address TEXT, phone TEXT, lat REAL NOT NULL, lng REAL NOT NULL,
  fleetbase_fleet_id TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ingest_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, external_id TEXT, error TEXT NOT NULL, payload TEXT NOT NULL, at TEXT NOT NULL, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS integrations (name TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS webhook_seen (id TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS order_seq (day TEXT PRIMARY KEY, n INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS driver_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id TEXT NOT NULL, batch_id INTEGER, lat REAL NOT NULL, lng REAL NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS driver_loc_driver_at ON driver_locations(driver_id, at);
CREATE INDEX IF NOT EXISTS driver_loc_batch ON driver_locations(batch_id, at);
CREATE INDEX IF NOT EXISTS driver_loc_at ON driver_locations(at);

CREATE TABLE IF NOT EXISTS customer_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                   -- phone | address
  value_key TEXT NOT NULL,              -- normalised phone, or "POSTCODE|line1 alphanumerics"
  label TEXT,                           -- human-readable (the phone as typed, or the address)
  level TEXT NOT NULL,                  -- flagged | blocked
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL, cleared_at TEXT, cleared_by TEXT
);
CREATE INDEX IF NOT EXISTS flags_lookup ON customer_flags(kind, value_key);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, reporter TEXT NOT NULL,   -- admin | driver:<id>
  type TEXT NOT NULL, note TEXT NOT NULL, photo TEXT,
  order_id INTEGER, driver_id TEXT,
  status TEXT NOT NULL DEFAULT 'open', resolved_at TEXT, resolved_note TEXT
);
CREATE INDEX IF NOT EXISTS incidents_at ON incidents(at);
CREATE INDEX IF NOT EXISTS incidents_order ON incidents(order_id);
`;

export function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  for (const [table, col, def] of [['orders', 'picked_at', 'TEXT'], ['orders', 'fb_dropoff_place', 'TEXT'], ['orders', 'fb_customer', 'TEXT'], ['orders', 'custom_json', 'TEXT']]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
  return db;
}

export const q = {
  all: (db, sql, ...p) => db.prepare(sql).all(...p),
  get: (db, sql, ...p) => db.prepare(sql).get(...p) ?? null,
  run: (db, sql, ...p) => db.prepare(sql).run(...p),
};

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
