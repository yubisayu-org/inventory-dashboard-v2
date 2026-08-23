-- "Propose a price revision" and "Create product from approved offer"
-- (order-requests page) only ever supported the Profit Margin (overseas)
-- formula. Adding Tier Kurs as a second option needs to remember WHICH
-- method a proposal used — proposed_profit_pct/operational_fee (migration
-- 089) only make sense for Profit Margin, and Tier Kurs instead needs the
-- resolved rate it was actually charged at, snapshotted the same way
-- products.tiered_kurs already is.
ALTER TABLE catalogue_requests
  ADD COLUMN proposed_pricing_method text NOT NULL DEFAULT 'overseas',
  ADD COLUMN proposed_tiered_kurs integer;

ALTER TABLE catalogue_requests
  ADD CONSTRAINT catalogue_requests_proposed_pricing_method_check
  CHECK (proposed_pricing_method IN ('overseas', 'tier_kurs'));
