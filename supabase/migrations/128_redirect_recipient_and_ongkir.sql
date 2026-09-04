-- Who receives a redirected parcel, and what sending it there costs.
--
-- A redirect is often to somebody else's house — her mother's, a friend who is
-- home during the day — and that parcel wants that person's name and phone on
-- the label, not hers. Empty means "use her own", which is what every redirect
-- recorded before today meant.
--
-- temp_ongkir_per_kg is the courier's quote for the area she redirected to,
-- kept so the charge can be recomputed when the parcel is weighed and so staff
-- can see the figure that was used. NULL means no quote: either nothing has
-- been redirected, or the courier will not price that area — there are a
-- handful JNE does not quote through Biteship — and in that case nothing is
-- charged and the Ship screen says so.

ALTER TABLE customer_shipping_prefs
  ADD COLUMN temp_name text NOT NULL DEFAULT '',
  ADD COLUMN temp_phone text NOT NULL DEFAULT '',
  ADD COLUMN temp_ongkir_per_kg integer;

-- No grants for catalogue_public here on purpose. The catalogue's own routes
-- reach these columns through the elevated pool, and the rate is written by
-- the server from a courier quote — never by anything a customer can post.
