-- Catalogue: photo/video posts (one asset, optionally tagging several
-- products) and the requests customers submit against them. See
-- docs/superpowers/specs/2026-08-12-catalogue-order-requests-design.md.

CREATE TABLE catalogue_posts (
  id          SERIAL PRIMARY KEY,
  media_url   TEXT NOT NULL,
  media_type  TEXT NOT NULL CHECK (media_type IN ('photo', 'video')),
  caption     TEXT NOT NULL DEFAULT '',
  visible     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ
);

CREATE TABLE catalogue_post_products (
  post_id     INTEGER NOT NULL REFERENCES catalogue_posts(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, product_id)
);

-- No FK on customer_handle: a customer can submit a request before ever
-- appearing in `customers` (unlike orders.customer, which requires — and
-- appendOrders self-heals — a customers row only once a real order exists).
CREATE TABLE catalogue_requests (
  id                 SERIAL PRIMARY KEY,
  customer_handle    TEXT NOT NULL,
  product_id         INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty                INTEGER NOT NULL CHECK (qty > 0),
  note               TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'converted', 'rejected')),
  staff_note         TEXT NOT NULL DEFAULT '',
  converted_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ
);

CREATE INDEX idx_catalogue_requests_handle
  ON catalogue_requests (lower(replace(customer_handle, '@', '')));
CREATE INDEX idx_catalogue_requests_status
  ON catalogue_requests (status) WHERE status = 'pending';
CREATE INDEX idx_catalogue_post_products_product
  ON catalogue_post_products (product_id);
