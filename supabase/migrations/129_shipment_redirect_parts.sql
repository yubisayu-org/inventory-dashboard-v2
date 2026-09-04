-- The redirect a parcel actually left with, kept in its parts.
--
-- shipments.temp_address already holds the label text, which is enough to
-- print and not enough to correct: it has no area on it, so a change made
-- after dispatch could not be priced and could not even be compared against
-- what was priced before.
--
-- This is the window that matters. Pressing Ship moves a parcel to Shipments
-- while the boxes are still being packed one at a time, and a customer asking
-- for a different address in that gap is ordinary. Correcting it there now
-- re-prices, so the shop stops absorbing the difference.

ALTER TABLE shipments
  ADD COLUMN temp_area_id text NOT NULL DEFAULT '',
  ADD COLUMN temp_area_name text NOT NULL DEFAULT '',
  ADD COLUMN temp_name text NOT NULL DEFAULT '',
  ADD COLUMN temp_phone text NOT NULL DEFAULT '';

COMMENT ON COLUMN shipments.temp_area_id IS
  'The Biteship area this parcel was sent to, when it was redirected. Empty means it went to her own address, or predates this column.';
