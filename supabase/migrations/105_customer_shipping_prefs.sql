-- What the customer wants done with one event's parcel, recorded before
-- anything ships.
--
-- This cannot live on `shipments`: that row does not exist until the shop
-- presses ship, and every choice here is made before that moment.
--
--   mode         when the parcel goes:
--                  'wait'  — ships once, complete. The default.
--                  'split' — send what has arrived now, rest follows. Costs a
--                            second ongkir, which the customer is shown first.
--                  'hold'  — out of the ship queue until released.
--   merge_key    events sharing one travel in a single box. A shared key
--                rather than a pairwise link, because membership of a set
--                cannot contradict itself the way "A goes with B, B goes with
--                C" can. NULL — the default — means ship this one alone.
--   temp_address a one-off receiving address for this parcel. NULL falls back
--                to the customer's profile address, exactly as
--                shipCustomerOrders already does with its own temp_address.

CREATE TABLE IF NOT EXISTS customer_shipping_prefs (
  customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  event        TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE ON DELETE CASCADE,
  mode         TEXT NOT NULL DEFAULT 'wait' CHECK (mode IN ('wait', 'split', 'hold')),
  merge_key    TEXT,
  temp_address TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, event)
);

-- "Which events travel with this one" is the only lookup the group needs.
CREATE INDEX IF NOT EXISTS idx_shipping_prefs_merge
  ON customer_shipping_prefs (customer_id, merge_key)
  WHERE merge_key IS NOT NULL;

-- ── catalogue_public ────────────────────────────────────────────────────────
-- The customer writes her own wish and reads it back. updated_at is not
-- writable: it is set by the server, and a client-supplied timestamp is not
-- evidence of anything.
--
-- Row scoping lives in the query's WHERE clause, as everywhere else on this
-- path; these grants only decide which COLUMNS could ever be reached if that
-- clause were wrong. The payment gate — no choices until the event is settled —
-- is enforced in lib/db/shipping-prefs.ts, because it depends on the invoice
-- roll-up rather than on any column here.
GRANT SELECT (customer_id, event, mode, merge_key, temp_address, updated_at)
  ON customer_shipping_prefs TO catalogue_public;
GRANT INSERT (customer_id, event, mode, merge_key, temp_address)
  ON customer_shipping_prefs TO catalogue_public;
GRANT UPDATE (mode, merge_key, temp_address, updated_at)
  ON customer_shipping_prefs TO catalogue_public;

-- No DELETE: clearing a preference is setting it back to 'wait' with a NULL
-- key, which leaves a row saying so. A missing row and a deliberate default
-- are different facts, and the shop's Ship screen reads both.
