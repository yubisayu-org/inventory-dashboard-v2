-- The delivery that brings boxes from the supplier to the warehouse.
--
-- A box is what the shop packs; a cargo is what the freight company moves, and
-- one cargo carries several boxes -- often from several trips. Until now the
-- box was the top of the tree, so "everything that came in that delivery" could
-- only be asked as "everything received that week", which is why the received
-- report had a date range at all.
--
-- Three small changes, no new hierarchy:

-- 1. The cargo is recorded on the arrival, beside the box.
--
-- On `orders` rather than on a box, because both fields are optional and one
-- gets typed without the other: units counted in with a cargo and no box code
-- are a real pile, and a box with no cargo is a real box. A box takes its cargo
-- from the arrivals that filled it, which is true by construction.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cargo_receipt TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS orders_cargo_receipt_idx
  ON orders (upper(cargo_receipt)) WHERE cargo_receipt <> '';

-- 2. What a cargo knows about itself: its weight, and nothing else.
--
-- Deliberately not its cost. The cost is one or more bills -- freight, customs,
-- trucking -- and they live in operational_expenses where every other rupiah
-- lives. A copy here would be a second answer to the same question, and the day
-- one of them is corrected nothing could say which was right.
CREATE TABLE IF NOT EXISTS cargos (
  receipt     TEXT PRIMARY KEY,
  weight_kg   INTEGER,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. An expense can say which cargo it paid for.
--
-- Nullable and untagged by default: most expenses are not cargo, and the 28
-- Cargo rows already in the ledger can be attached one at a time without
-- anything being retyped.
ALTER TABLE operational_expenses ADD COLUMN IF NOT EXISTS cargo_receipt TEXT;

CREATE INDEX IF NOT EXISTS operational_expenses_cargo_receipt_idx
  ON operational_expenses (upper(cargo_receipt)) WHERE cargo_receipt IS NOT NULL;
