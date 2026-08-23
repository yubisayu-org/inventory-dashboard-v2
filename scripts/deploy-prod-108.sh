#!/usr/bin/env bash
# Apply migration 108 to production: restore the invoice_reader grants that 100
# took away, keeping the margin structure and events.catalog_secret revoked.
set -euo pipefail
cd "$(dirname "$0")/.."

URL="postgresql://postgres.aihubvlvxukiiymhzewh@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"

if [ -z "${SUPABASE_DB_PASSWORD:-}" ]; then
  read -rsp "Supabase DB password (inventory-dashboard-prod): " SUPABASE_DB_PASSWORD; echo
fi
export PGPASSWORD="$SUPABASE_DB_PASSWORD"

echo "==> before"
psql "$URL" -At -F' | ' -c "
SELECT table_name, COALESCE(string_agg(column_name,', ' ORDER BY ordinal_position)
  FILTER (WHERE NOT has_column_privilege('invoice_reader',table_name,column_name,'SELECT')), '(none)')
FROM information_schema.columns WHERE table_schema='public'
  AND table_name IN ('orders','events','payments','adjustments','shipments','products')
GROUP BY table_name ORDER BY table_name;"

echo
echo "==> applying 108"
psql "$URL" -v ON_ERROR_STOP=1 -1 -f supabase/migrations/108_invoice_reader_unbreak.sql

echo
echo "==> after - only margin columns and catalog_secret should remain denied"
psql "$URL" -At -F' | ' -c "
SELECT table_name, COALESCE(string_agg(column_name,', ' ORDER BY ordinal_position)
  FILTER (WHERE NOT has_column_privilege('invoice_reader',table_name,column_name,'SELECT')), '(none)')
FROM information_schema.columns WHERE table_schema='public'
  AND table_name IN ('orders','events','payments','adjustments','shipments','products')
GROUP BY table_name ORDER BY table_name;"

echo
echo "==> margin must still be sealed"
psql "$URL" -At -c "
SELECT 'margin_leaking=' || bool_or(has_column_privilege('invoice_reader','products',c,'SELECT'))
FROM unnest(ARRAY['cost','profit_pct','profit_fixed','cargo_per_kg','operational_fee','packing_fee']) c;
SELECT 'catalog_secret_readable=' || has_column_privilege('invoice_reader','events','catalog_secret','SELECT');"

echo
echo "Now reload https://yubisayu-invoice.netlify.app/api/orders?instagramId=summerfey"
