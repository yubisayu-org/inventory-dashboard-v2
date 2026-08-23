-- Announcements the shop writes and every signed-in customer receives.
--
-- One row per announcement, no recipient table: an announcement goes to
-- everyone. Targeting a subset would need a join table, and adding one later
-- does not migrate anything written before it — a row with no recipients is
-- still "everyone" under the query below.
--
-- Read state is per customer, which is what makes this an inbox rather than a
-- noticeboard. A missing row means unread, so nothing has to be written when
-- an announcement is published — only when someone opens it. That also means
-- a customer who signs up tomorrow sees today's announcement as unread, which
-- is the behaviour you want: it is new *to them*.

CREATE TABLE IF NOT EXISTS announcements (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL CHECK (btrim(title) <> ''),
  body       TEXT NOT NULL CHECK (btrim(body) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Newest first is the only order the inbox ever asks for.
CREATE INDEX IF NOT EXISTS idx_announcements_created_at
  ON announcements (created_at DESC);

CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  customer_id     INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (announcement_id, customer_id)
);

-- The unread count is "announcements minus this customer's reads", so every
-- lookup is by customer.
CREATE INDEX IF NOT EXISTS idx_announcement_reads_customer
  ON announcement_reads (customer_id);

-- ── catalogue_public ────────────────────────────────────────────────────────
-- Column-scoped like every other grant on this role. updated_at is not here:
-- the customer is shown when something was published, and an edit that
-- silently changed that date would be worse than not showing it.
GRANT SELECT (id, title, body, created_at) ON announcements TO catalogue_public;

-- read_at is written by DEFAULT NOW(), never supplied by the caller — the
-- customer's clock is not evidence of anything.
GRANT SELECT (announcement_id, customer_id) ON announcement_reads TO catalogue_public;
GRANT INSERT (announcement_id, customer_id) ON announcement_reads TO catalogue_public;

-- No UPDATE and no DELETE anywhere on this role: a customer can mark an
-- announcement read, and that is the only mark they can leave. Unreading it
-- is not a feature, and deleting the shop's announcement certainly is not.
