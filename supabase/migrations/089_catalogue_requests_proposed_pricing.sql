-- editCatalogueRequest ("Propose a price revision") computes estimated_price
-- from profit%/op fee/pack fee but only ever stored the resulting number —
-- the inputs that actually produced it were discarded. That meant "Create
-- product from approved offer" had no way to start from the terms the owner
-- actually proposed and the customer approved; it could only guess at a
-- fixed 15%/0/0, even when the real approved deal was e.g. 20%/5000/0.
--
-- Owner-only column: never touched by the public catalogue_public role
-- (no GRANT here), same as estimated_price's own write path.
ALTER TABLE catalogue_requests
  ADD COLUMN proposed_profit_pct integer,
  ADD COLUMN proposed_operational_fee integer,
  ADD COLUMN proposed_packing_fee integer;
