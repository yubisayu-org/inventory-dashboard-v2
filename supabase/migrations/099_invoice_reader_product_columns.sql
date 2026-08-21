-- Narrow invoice_reader's products grant from whole-table to three columns.
--
-- 018_invoice_reader_role.sql granted SELECT on all of `products`, which let the
-- PUBLIC, no-login recap connection read cost, profit_pct, profit_fixed, valas,
-- kurs and cargo_per_kg — the full margin structure. The recap never showed any
-- of it; the grant was simply wider than the query.
--
-- getPublicInvoiceForCustomer (lib/db/invoice.ts) touches exactly three product
-- columns: `name` and `gram` in the SELECT list, and `id` for the join
-- `products p ON p.id = o.product_id`. Nothing else uses this role — the only
-- consumer of lib/db-public.ts is app/api/public/invoice/route.ts.
--
-- This mirrors the column-level grant already used for `customers` in 018, and
-- it changes no API response shape.
--
-- FAIL-CLOSED, BY DESIGN: adding a product column to the public query later
-- without extending this grant raises a permission error at runtime rather than
-- silently widening what the public endpoint can read. If the public recap ever
-- legitimately needs another column, add it here in the same commit.
--
-- Note there is no inherited grant path to undo: the ALTER DEFAULT PRIVILEGES in
-- 019_app_runtime_role.sql targets app_runtime only, so the REVOKE below is
-- sufficient. Re-running this migration is safe.

REVOKE SELECT ON products FROM invoice_reader;
GRANT SELECT (id, name, gram) ON products TO invoice_reader;
