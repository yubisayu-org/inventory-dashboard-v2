-- What a parcel is actually priced at: the courier's quote, or our own rate
-- when there is no quote.
--
-- `ongkos_kirim` is the rate imported from JNE's published price list.
-- `biteship_ongkir` (migration 120) is what JNE quoted for the customer's
-- Biteship area on 30-31 August 2026. Where the two disagree the quote wins:
-- the owner judged the differences to be typos in the old list rather than
-- discounts anybody granted -- the whole gap was Rp 325.000 absorbed and
-- Rp 448.000 overcharged, lifetime, across every trip.
--
-- Why a generated column rather than writing COALESCE at each call site:
-- `cwo.ongkos_kirim` is read at sixteen places across eight files -- invoice,
-- dashboard, finance, shopping list, parcel plan, fulfilment, shipping prefs,
-- mark refunds. Sixteen copies of a pricing rule is sixteen chances for one to
-- drift, and a site that priced differently from the rest would do it silently.
-- Here the rule exists once and Postgres keeps it true.
--
-- STORED, not VIRTUAL: it is read far more often than written, and it can be
-- indexed if a report ever needs it.
--
-- `ongkos_kirim` is NOT removed and must not be. It is the fallback for the
-- fourteen rows JNE will not quote through Biteship at all -- Sukaraja/Bogor,
-- Paal Merah/Jambi, Alam Barajo/Jambi, Kranggan/Mojokerto -- whose figures came
-- from JNE's own website by hand. It is also what the customer editor writes
-- when somebody prices an address by hand.

ALTER TABLE customer_warehouse_ongkir
  ADD COLUMN IF NOT EXISTS effective_ongkir INTEGER
  GENERATED ALWAYS AS (COALESCE(biteship_ongkir, ongkos_kirim)) STORED;

COMMENT ON COLUMN customer_warehouse_ongkir.effective_ongkir IS
  'What a parcel is priced at: the courier''s quote, or our own rate when there is none. Generated -- never written to directly.';
