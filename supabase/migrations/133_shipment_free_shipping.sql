-- Delivery given away, recorded on the parcel that was given.
--
-- The gift used to be an adjustment written straight at dispatch, which put
-- two writers on the same customer's ongkir: reconcileParcelPlan treats any
-- automatic row on a trip as its own, so a merge arriving later could rewrite
-- the gift, and on a merged box the gift had no way to know which invoices
-- were still carrying a charge.
--
-- So the parcel says it was free, and the one routine that already knows what
-- every trip in the box was charged gives it back — cheapest charge first,
-- exactly as it does for a merge, until nothing is charged at all. She still
-- reads a discount line and still gets the notice; there is simply one place
-- doing the arithmetic.

ALTER TABLE shipments
  ADD COLUMN free_shipping boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN shipments.free_shipping IS
  'The shop gave this parcel''s delivery away. The invoice still charges the ongkir and credits it back, so the gift is visible rather than looking like a rate nobody recorded.';
