-- A temporary address gets the same treatment as the permanent one: the area
-- is searched, never typed.
--
-- Free-text kota/kecamatan is how a destination ends up matching no shipping
-- rate — the reason the profile form has had a Biteship picker since it was
-- built. A one-off address is the case where a typo is *most* likely (she is
-- typing an address that is not hers, from memory), so it gets the picker too.
--
--   temp_area_id    the Biteship area, as chosen. Never composed by hand.
--   temp_area_name  the label that came with it, kept so the shop can print
--                   and read it without a second Biteship call. Denormalised
--                   on purpose: a label that changes upstream must not
--                   retroactively change what was on a parcel already sent.
--
-- Deliberately NOT re-priced. updateCustomerProfile re-runs lookupOngkir when
-- a customer moves, because that is her new home. A one-off redirect is not a
-- move, and silently re-rating her standing ongkir off a two-week stay at her
-- aunt's would be worse than the alternative — the Ship screen flags when the
-- area differs instead, and a human decides.

ALTER TABLE customer_shipping_prefs
  ADD COLUMN IF NOT EXISTS temp_area_id   TEXT,
  ADD COLUMN IF NOT EXISTS temp_area_name TEXT;

-- ── catalogue_public ────────────────────────────────────────────────────────
-- Same shape as the address itself: hers to write, hers to read back.
GRANT SELECT (temp_area_id, temp_area_name) ON customer_shipping_prefs TO catalogue_public;
GRANT INSERT (temp_area_id, temp_area_name) ON customer_shipping_prefs TO catalogue_public;
GRANT UPDATE (temp_area_id, temp_area_name) ON customer_shipping_prefs TO catalogue_public;
