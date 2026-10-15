-- The delivery tables as they were in the hub (migration 46), moved out with the dispatch code.
-- The four bookkeeping columns (created_at, updated_at, updated_by, deleted_at) are the hub's shared COMMON set, written out below.
-- NOTE: `kitchen_order_id` and `customer_id` pointed at the hub's kitchen_orders / customers; here they become references to the hub's API (/api/v1/orders, /api/v1/customers).

    -- Delivery dispatch: the hub for a driver app, a customer tracking page and the own-website ordering system.
    -- Customers hold personal data (name, phone, address): they can be erased, and are kept out of the analytics copy.
    CREATE TABLE IF NOT EXISTS customers (
      id          TEXT PRIMARY KEY,
      name        TEXT,
      phone       TEXT,
      email       TEXT,
      address     TEXT,
      postcode    TEXT,
      note        TEXT,
      marketing_ok INTEGER NOT NULL DEFAULT 0,
      erased_at   TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_customers_phone ON customers(phone);
    CREATE TABLE IF NOT EXISTS drivers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      phone       TEXT,
      vehicle     TEXT,
      max_items   INTEGER,                    -- most items on one run; blank = no limit (the owner's number, never invented)
      active      INTEGER NOT NULL DEFAULT 1,
      token_hash  TEXT,                       -- SHA-256 of the driver app's key; the key itself is shown once
      last_lat    REAL,
      last_lng    REAL,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id              TEXT PRIMARY KEY,
      site_id         TEXT NOT NULL REFERENCES sites(id),
      kitchen_order_id TEXT REFERENCES kitchen_orders(id),
      customer_id     TEXT REFERENCES customers(id),
      recipient       TEXT,
      phone           TEXT,
      address         TEXT,
      postcode        TEXT,
      area            TEXT,                   -- the outward code (SW11), used to group a run
      items           INTEGER NOT NULL DEFAULT 1,
      status          TEXT NOT NULL DEFAULT 'waiting',   -- waiting | assigned | out | delivered | failed | cancelled
      driver_id       TEXT REFERENCES drivers(id),
      tracking_token  TEXT,
      note            TEXT,
      placed_at       TEXT NOT NULL,
      promised_at     TEXT,
      assigned_at     TEXT,
      out_at          TEXT,
      delivered_at    TEXT,
      failed_reason   TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_deliveries ON deliveries(site_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_deliveries_token ON deliveries(tracking_token) WHERE tracking_token IS NOT NULL;
    CREATE TABLE IF NOT EXISTS delivery_messages (
      id          TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL REFERENCES deliveries(id),
      from_kind   TEXT NOT NULL,              -- office | driver | customer
      from_name   TEXT,
      body        TEXT NOT NULL,
      audience    TEXT NOT NULL DEFAULT 'team',   -- team (office and driver only) | all (the customer sees it too)
      read_at     TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_delivery_messages ON delivery_messages(delivery_id);
    