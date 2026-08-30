-- What the courier would charge, beside what we charge.
--
-- `ongkos_kirim` is the shop's own per-kilo rate: it is what the invoice bills,
-- most of it carried over from the old JNE table, some of it typed by hand a
-- year ago. Whether it still matches what JNE actually charges was unknowable
-- without asking Biteship, and asking costs money per request -- so the answer
-- was thrown away as soon as it was printed.
--
-- Its own column, never overwriting ours. A quote is evidence, not a decision:
-- some of these differences are somebody's deliberate discount and some are a
-- typo from last year, and only a person can say which. Nothing in the app
-- reads this column to price anything.
ALTER TABLE customer_warehouse_ongkir
  ADD COLUMN IF NOT EXISTS biteship_ongkir INT,
  ADD COLUMN IF NOT EXISTS biteship_quoted_at TIMESTAMPTZ;

COMMENT ON COLUMN customer_warehouse_ongkir.biteship_ongkir IS
  'Courier quote for a 1kg parcel from this warehouse, in rupiah. Evidence only — the invoice bills ongkos_kirim.';
COMMENT ON COLUMN customer_warehouse_ongkir.biteship_quoted_at IS
  'When that quote was taken. NULL means never quoted.';
