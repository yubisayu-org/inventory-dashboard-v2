-- Let the catalogue offer stock the shop already owns.
--
-- excess_purchase is the overbuy/overship table the Inventory screen reads.
-- Four columns are enough to list it: what it is, how many were bought, how
-- many have landed, and the row's own id.
--
-- NOT granted, and this is the point:
--   reason          — overbuy / overship / wrong_product. Why the shop happens
--                     to have an item is not the customer's business, and
--                     "wrong item sent to us" on a listing is a bad look.
--   receipt,
--   dispatch_receipt — procurement paperwork.
--   event           — which trip it came off; internal naming.
--
-- Price is not here either: it is joined from products by name, and
-- catalogue_public already reads (id, name, store, price) there.
GRANT SELECT (id, items, unit_buy, unit_arrive, created_at)
  ON excess_purchase TO catalogue_public;
