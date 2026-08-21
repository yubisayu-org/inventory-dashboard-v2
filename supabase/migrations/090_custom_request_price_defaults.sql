-- "Propose a price revision" and "Create product from approved offer"
-- (order-requests page) used to hardcode 15%/0/0 in code, meant to mirror
-- the customer-facing form's own formula (separate repo) — every time that
-- formula changed there, it had to be hand-edited here too. Moves it into
-- Settings instead: one place, editable without a deploy, same pattern as
-- product_defaults' existing Add Product fields.
--
-- Defaults match what the fixed constants already were (15/5000/0), so an
-- existing install's behavior doesn't change until the owner touches this
-- in Settings.
ALTER TABLE product_defaults
  ADD COLUMN custom_request_profit_pct numeric(6,2) NOT NULL DEFAULT 15,
  ADD COLUMN custom_request_operational_fee integer NOT NULL DEFAULT 5000,
  ADD COLUMN custom_request_packing_fee integer NOT NULL DEFAULT 0;
