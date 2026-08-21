-- Customer-editable profile, and canonical addresses via Biteship areas.
--
-- Two things at once because they are the same change: letting a customer edit
-- their own address is only safe if the area is picked from a canonical list
-- rather than typed. Today kota/kecamatan are free text matched against
-- jne_rates, and a spelling that matches no row leaves ongkir at 0 — a typo
-- means free shipping. An area_id cannot be misspelled.

-- The area name is stored alongside the id so the profile sheet and the
-- customer list can render without spending a Maps request to resolve it.
ALTER TABLE customers
  ADD COLUMN biteship_area_id   TEXT,
  ADD COLUMN biteship_area_name TEXT;

-- Origin for rate lookups. Nullable: the single existing warehouse keeps
-- working on jne_rates until someone fills this in, and rate fetching stays
-- dormant until then rather than failing.
ALTER TABLE warehouses
  ADD COLUMN biteship_area_id   TEXT,
  ADD COLUMN biteship_area_name TEXT,
  ADD COLUMN postal_code        TEXT NOT NULL DEFAULT '';

-- Set when a saved address could not be priced — no Biteship origin and no
-- matching jne_rates row. The previous ongkir is deliberately left in place,
-- so this column is how staff find the customers that need a manual rate
-- rather than discovering it on an invoice.
ALTER TABLE customers
  ADD COLUMN ongkir_needs_review BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX idx_customers_ongkir_needs_review ON customers (id)
  WHERE ongkir_needs_review;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- The customer profile sheet reads these. Contact and address only: no
-- bank_name, bank_account_number, bank_account_holder, and no ongkos_kirim —
-- what they are charged is not theirs to read from this path.
--
-- No UPDATE is granted. Profile writes run through the main pool once the
-- session is verified, the same way invite redemption and Google binding do,
-- because saving an address also writes customer_warehouse_ongkir and
-- granting the public role write access to two tables for one rare path
-- widens the boundary far more than it is worth.
GRANT SELECT (name, whatsapp, data_diri, kota, kecamatan, kode_pos,
              biteship_area_id, biteship_area_name)
  ON customers TO catalogue_public;
