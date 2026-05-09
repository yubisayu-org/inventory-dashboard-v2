-- Yubisayu Inventory Dashboard — Supabase (Postgres) schema
-- Run this against your Supabase project via the SQL editor.

CREATE TABLE events (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  eta  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE customers (
  id           SERIAL PRIMARY KEY,
  instagram_id TEXT NOT NULL UNIQUE,
  whatsapp     TEXT NOT NULL DEFAULT '',
  data_diri    TEXT NOT NULL DEFAULT '',
  ekspedisi    TEXT NOT NULL DEFAULT '',
  ongkos_kirim INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE products (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL,
  store TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0,
  gram  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (name, store)
);

CREATE INDEX idx_products_name ON products (name);

CREATE TABLE products_indo (
  id      SERIAL PRIMARY KEY,
  product TEXT NOT NULL,
  store   TEXT NOT NULL DEFAULT '',
  price   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE orders (
  id          SERIAL PRIMARY KEY,
  event       TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  customer    TEXT NOT NULL REFERENCES customers(instagram_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  unit_price  INTEGER NOT NULL DEFAULT 0,
  unit        INTEGER NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ,
  unit_buy    INTEGER,
  receipt     TEXT NOT NULL DEFAULT '',
  unit_arrive INTEGER,
  unit_ship   INTEGER,
  unit_hold   INTEGER
);

CREATE INDEX idx_orders_event ON orders (event);
CREATE INDEX idx_orders_customer ON orders (lower(customer));
CREATE INDEX idx_orders_customer_normalized ON orders (lower(replace(customer, '@', '')));
CREATE INDEX idx_orders_event_product ON orders (event, product_id);

CREATE TABLE excess_purchase (
  id         SERIAL PRIMARY KEY,
  event      TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  items      TEXT NOT NULL,
  unit_buy   INTEGER NOT NULL,
  receipt    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX idx_excess_event_items ON excess_purchase (event, items);

CREATE TABLE shipments (
  id                SERIAL PRIMARY KEY,
  event             TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  customer          TEXT NOT NULL REFERENCES customers(instagram_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  shipping_id       TEXT NOT NULL UNIQUE,
  invoicing         TEXT NOT NULL DEFAULT '',
  weight_estimation NUMERIC(10,2) NOT NULL DEFAULT 0,
  ongkir            INTEGER NOT NULL DEFAULT 0,
  ongkir_total      INTEGER NOT NULL DEFAULT 0,
  is_last_shipment  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ,
  tracking_number   TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_shipments_customer ON shipments (lower(customer));

CREATE TABLE payments (
  id         SERIAL PRIMARY KEY,
  event      TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE ON DELETE RESTRICT,
  customer   TEXT NOT NULL REFERENCES customers(instagram_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  amount     INTEGER NOT NULL DEFAULT 0,
  account    TEXT NOT NULL DEFAULT '',
  is_checked BOOLEAN NOT NULL DEFAULT FALSE,
  pay_date   TEXT NOT NULL DEFAULT '',
  remarks    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX idx_payments_event_customer ON payments (event, lower(customer));
