-- Target Price: a sixth pricing method where the SELLING PRICE is the input.
--
-- Every other method derives the price from the cost — a margin percentage, a fee, or an
-- inflated rate. This one inverts that: the owner knows what the item has to sell for
-- (a competitor's price, a round number a customer agreed to), types it, and the margin
-- is whatever falls out. The price is therefore stored verbatim: no rounding step, no fee
-- added on top. Rounding a number the owner chose deliberately would defeat the method.
--
-- No new columns. Cost lands on products.cost as it does for every method, and the
-- resulting margin (price − cost) is snapshotted onto products.profit_fixed — the same
-- column the three fee methods use for the same idea, "the rupiah figure between cost and
-- price". A dedicated column would mean a second thing for the products table and every
-- downstream report to know about, to store a number with identical meaning.
--
-- Both CHECK lists move together, as migration 055 warns: there is no shared enum type.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_pricing_method_check;
ALTER TABLE products ADD CONSTRAINT products_pricing_method_check
  CHECK (pricing_method IN ('overseas', 'tier_fee', 'flat_fee', 'tier_kurs', 'flat_kurs', 'target_price'));

ALTER TABLE product_defaults DROP CONSTRAINT IF EXISTS product_defaults_default_pricing_method_check;
ALTER TABLE product_defaults ADD CONSTRAINT product_defaults_default_pricing_method_check
  CHECK (default_pricing_method IN ('overseas', 'tier_fee', 'flat_fee', 'tier_kurs', 'flat_kurs', 'target_price'));
