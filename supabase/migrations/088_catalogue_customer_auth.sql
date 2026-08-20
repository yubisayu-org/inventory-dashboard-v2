-- Customer sign-in for the public catalogue site.
--
-- Identity lives on the EXISTING customers table rather than a parallel one:
-- customers.instagram_id is already the key the catalogue orders under (see
-- the customers_instagram_normalized_uniq index), and a second identity table
-- would need permanent reconciliation with it.
--
-- The design: a single-use invite the shop sends by hand answers "which
-- customer is this" — the shop chooses the recipient — and Google answers "is
-- this the same person as last time". Neither alone is enough. Instagram
-- cannot do it at all: its Basic Display API shut down in December 2024 and
-- the successor authenticates business/creator accounts only.
--
-- customers holds bank details, so the grants at the bottom are the security
-- surface of this whole feature. catalogue_public gets four columns and no
-- UPDATE; binding, invites and revocation all run through the main pool in
-- staff-side code.

ALTER TABLE customers
  ADD COLUMN google_sub       TEXT UNIQUE,
  ADD COLUMN catalogue_access TEXT NOT NULL DEFAULT 'none'
      CHECK (catalogue_access IN ('none', 'invited', 'active', 'revoked')),
  ADD COLUMN bound_at         TIMESTAMPTZ;

-- The UNIQUE above already enforces one Google account per customer; this
-- partial index serves the returning-customer sign-in lookup without indexing
-- the many NULLs.
CREATE INDEX idx_customers_google_sub ON customers (google_sub)
  WHERE google_sub IS NOT NULL;

-- Single use, and only ever performs the binding — so a link that leaks after
-- redemption is worthless.
CREATE TABLE customer_invites (
  id            SERIAL PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- sha256 of the token. The token itself is shown once, at generation, and
  -- never stored: a database dump must not yield working invites.
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  redeemed_at   TIMESTAMPTZ,
  -- Set when a re-issue replaces this invite. Without it, every link the shop
  -- has ever sent a customer would stay redeemable forever.
  superseded_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customer_invites_live ON customer_invites (customer_id)
  WHERE redeemed_at IS NULL AND superseded_at IS NULL;

-- Opaque server-side sessions rather than a signed token: revoking a customer
-- has to kill their live sessions immediately, and a stateless token cannot
-- be withdrawn.
CREATE TABLE customer_sessions (
  id           SERIAL PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customer_sessions_customer ON customer_sessions (customer_id);

-- Hands the catalogue site a session without ever putting the session token
-- in a URL, browser history, or a Referer header. 60-second TTL, single use.
CREATE TABLE customer_one_time_codes (
  code          TEXT PRIMARY KEY,
  session_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL
);

-- Public intake, for people the shop has no record of. Anyone who has ever
-- ordered already has a customers row, so they never use this — the shop
-- re-issues their invite instead.
CREATE TABLE catalogue_access_requests (
  id           SERIAL PRIMARY KEY,
  instagram_id TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected')),
  -- Set when the queue matches this handle to an existing customer, so the
  -- staff screen shows it as a re-issue rather than a new account. Two rows
  -- for one person would split their order history.
  customer_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at   TIMESTAMPTZ
);

CREATE INDEX idx_catalogue_access_requests_pending
  ON catalogue_access_requests (created_at) WHERE status = 'pending';

-- Link existing orders to their customer. customer_handle stays: it is the
-- only record of who placed a request that predates a customers row, and
-- deleting a customer must not orphan the history.
ALTER TABLE catalogue_requests
  ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;

UPDATE catalogue_requests r
   SET customer_id = c.id
  FROM customers c
 WHERE lower(replace(r.customer_handle, '@', ''))
     = lower(replace(c.instagram_id, '@', ''));

CREATE INDEX idx_catalogue_requests_customer ON catalogue_requests (customer_id);

-- ── Grants ──────────────────────────────────────────────────────────────────
-- The security boundary of this feature. customers holds bank_account_number,
-- bank_account_holder, whatsapp and data_diri; catalogue_public must never
-- reach any of them, and must never write to this table at all.
GRANT SELECT (id, instagram_id, google_sub, catalogue_access)
  ON customers TO catalogue_public;

-- Resolving a bearer token is the only session operation the public role
-- performs. Issuing and revoking run through the main pool.
GRANT SELECT ON customer_sessions TO catalogue_public;

-- The one public write. Column-scoped so a caller cannot pre-approve itself
-- by setting status, or attach itself to an existing customer_id.
GRANT INSERT (instagram_id, note) ON catalogue_access_requests TO catalogue_public;
GRANT USAGE, SELECT ON catalogue_access_requests_id_seq TO catalogue_public;

-- The public read path filters by customer_id now, so it must be able to see
-- that column. catalogue_requests already carries a table-wide SELECT from
-- migration 059; this is a no-op there but states the dependency.
GRANT SELECT (customer_id) ON catalogue_requests TO catalogue_public;

-- Writes now stamp the customer from the session. Column-scoped like the rest
-- of migration 059's INSERT grant, so the public role still cannot set status
-- or staff_note.
GRANT INSERT (customer_id) ON catalogue_requests TO catalogue_public;

-- Deliberately NOT granted: any privilege on customer_invites (redemption is
-- a main-pool operation) or customer_one_time_codes (the exchange endpoint
-- runs on the main pool too).
