-- Announcements grow a recipient, so the shop can tell one customer something
-- that concerns only her parcel.
--
-- Migration 103 said an announcement goes to everyone and that adding a
-- recipient table later would not migrate what came before it. That still
-- holds — which is why this is a nullable column on the row rather than a join
-- table: NULL means everyone, and every row written before today is NULL
-- already. Nothing to backfill, and the broadcast case stays the cheap one.
--
--   customer_id  NULL — everyone, the shop's own notices.
--                Set — one customer, and nobody else can read it.
--   kind         'notice'   the shop wrote it.
--                'shipping' the system wrote it because a parcel moved.
--                Kept apart so automatic notices do not bury the shop's own
--                writing on the Announcements screen.

ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'notice'
    CHECK (kind IN ('notice', 'shipping'));

-- The inbox asks "mine, plus everyone's, newest first" every single time.
CREATE INDEX IF NOT EXISTS idx_announcements_customer
  ON announcements (customer_id, created_at DESC);

-- ── catalogue_public ────────────────────────────────────────────────────────
-- Two more readable columns, nothing writable. Row scoping is the WHERE clause
-- as everywhere else on this path — `customer_id IS NULL OR customer_id = :me`,
-- with :me taken from the verified session and never from the request.
GRANT SELECT (customer_id, kind) ON announcements TO catalogue_public;
