-- Finish what 099 started: column-scope every remaining whole-table grant on
-- invoice_reader.
--
-- 018 granted `orders, products, events, payments, adjustments` as whole tables,
-- 020 added `shipments`, and 032 added `warehouses, customer_warehouse_ongkir`.
-- 099 narrowed products. These are the rest, and two of them matter:
--
--   events.catalog_secret  — the per-trip customer catalogue link. A no-login
--                            connection had SELECT on it.
--   orders.receipt, orders.dispatch_receipt, payments.account, orders.unit_buy
--                          — procurement and banking detail the recap never shows.
--
-- Columns below are exactly what getPublicInvoiceForCustomer reads (lib/db/
-- invoice.ts). Same fail-closed contract as 099: adding a column to that query
-- without extending the grant here raises a permission error rather than
-- silently widening what the public endpoint can read.
--
-- warehouses and customer_warehouse_ongkir are deliberately left whole: their
-- columns are rates and Biteship area ids, nothing private, and the recap joins
-- them for the shipping estimate.
--
-- Re-running is safe.

REVOKE SELECT ON orders, events, payments, adjustments, shipments FROM invoice_reader;

-- o.id orders the result; the rest are the recap's line items and their stages.
GRANT SELECT (id, event, customer, product_id, unit, unit_price, unit_arrive, unit_ship)
  ON orders TO invoice_reader;

-- e.created_at sorts the trips, e.eta shows the estimate, e.warehouse_id routes
-- the ongkir lookup. catalog_secret is NOT here, and that is the point.
GRANT SELECT (id, name, eta, created_at, warehouse_id)
  ON events TO invoice_reader;

-- Summed per event, filtered by is_checked. `account` and `remarks` stay out.
GRANT SELECT (event, customer, amount, is_checked) ON payments TO invoice_reader;

GRANT SELECT (event, customer, amount) ON adjustments TO invoice_reader;

-- Tracking numbers and the per-shipment ongkir the estimate uses.
GRANT SELECT (id, event, customer, ongkir, tracking_number, created_at)
  ON shipments TO invoice_reader;
