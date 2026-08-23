-- Migration 100 narrowed invoice_reader to the columns the DASHBOARD's own public
-- invoice query needs. The separate invoice site (yubisayu-invoice.netlify.app,
-- its own repo) selects more than that, and column grants are fail-closed, so
-- /api/orders started returning 500 the moment 100 landed.
--
-- The thing that had to stay private is the MARGIN STRUCTURE: cost, profit_pct,
-- profit_fixed, cargo_per_kg, operational_fee, packing_fee, and the rate inputs
-- (valas, kurs, tiered_kurs) that let it be reconstructed. None of that lives on
-- orders, payments, adjustments or shipments — those hold the customer's own
-- transaction, which the invoice is showing them anyway.
--
-- So: restore whole-table SELECT where nothing private lives, and keep column
-- grants only where something private actually does — products, and
-- events.catalog_secret. This is narrower than the pre-099 state (which leaked
-- the whole margin structure) and wider than 100 (which broke the site).

-- Customer's own transaction data. Nothing derived from cost lives here.
GRANT SELECT ON orders, payments, adjustments, shipments TO invoice_reader;

-- events: everything except the catalogue secret, which is a capability token —
-- anyone holding it can open a trip's catalogue.
GRANT SELECT (id, name, eta, created_at, updated_at, country_id, warehouse_id, is_active)
  ON events TO invoice_reader;

-- products: the one table where margin lives. Selling price and store are on the
-- invoice the customer already receives; everything cost-side stays revoked.
-- Deliberately NOT granted: valas, kurs, cargo_per_kg, profit_pct,
-- operational_fee, packing_fee, cost, profit_fixed, pricing_method, tiered_kurs,
-- flat_fee_mode.
GRANT SELECT (id, name, gram, store, price, country_id, is_active, created_at, updated_at)
  ON products TO invoice_reader;
