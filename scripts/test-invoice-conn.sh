#!/usr/bin/env bash
# Paste the INVOICE_READER_DATABASE_URL value from Railway when prompted.
# It is read silently and never printed, logged, or written to disk.
set -euo pipefail
cd "$(dirname "$0")/.."

read -rsp "Paste INVOICE_READER_DATABASE_URL from Railway: " CONN; echo
[ -n "$CONN" ] || { echo "empty"; exit 1; }

echo
echo "==> host / project / role (password masked)"
echo "$CONN" | sed -E 's#://([^:]*):[^@]*@#://\1:***@#'

echo
echo "==> can it connect at all?"
if psql "$CONN" -At -c "SELECT 'connected as '||current_user||' to '||current_database();" 2>&1; then
  :
else
  echo "   ^ connection itself failed - that is your 500."
  echo "     'password authentication failed' means the credential is stale (rotated)."
  echo "     'tenant or user not found' means it points at the dead old project."
  exit 1
fi

echo
echo "==> can it read what the invoice needs?"
psql "$CONN" -At -c "
SELECT 'products readable: ' || string_agg(column_name, ', ' ORDER BY ordinal_position)
FROM information_schema.columns
WHERE table_name='products'
  AND has_column_privilege(current_user,'products',column_name,'SELECT');"

echo
echo "==> the actual invoice query, as whatever role this URL is"
psql "$CONN" -At -c "
SELECT 'rows for summerfey = ' || count(*)
FROM orders o
JOIN products p ON p.id = o.product_id
LEFT JOIN events e ON e.name = o.event
WHERE lower(replace(o.customer,'@','')) = 'summerfey';"
