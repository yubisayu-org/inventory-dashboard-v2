#!/usr/bin/env bash
# Give invoice_reader its own password and produce the Railway env line, so the
# public invoice endpoint stops connecting as a superuser.
# The secret is generated here, never printed, never in shell history.
set -euo pipefail
cd "$(dirname "$0")/.."

URL="postgresql://postgres.aihubvlvxukiiymhzewh@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"
REF="aihubvlvxukiiymhzewh"
HOST="aws-1-ap-southeast-1.pooler.supabase.com:5432"

if [ -z "${SUPABASE_DB_PASSWORD:-}" ]; then
  read -rsp "NEW postgres password (the one you just rotated to): " SUPABASE_DB_PASSWORD; echo
fi
export PGPASSWORD="$SUPABASE_DB_PASSWORD"

echo "==> checking the role can log in at all"
psql "$URL" -At -c "
SELECT 'invoice_reader: ' ||
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='invoice_reader') THEN 'MISSING'
       WHEN (SELECT rolcanlogin FROM pg_roles WHERE rolname='invoice_reader') THEN 'exists, LOGIN ok'
       ELSE 'exists but NOLOGIN' END;
SELECT 'has CONNECT on db: ' || has_database_privilege('invoice_reader', current_database(), 'CONNECT');"

echo
echo "==> setting a fresh password on invoice_reader"
SECRET=$(openssl rand -hex 32)
printf "ALTER ROLE invoice_reader WITH LOGIN PASSWORD :'secret';\n" \
  | psql "$URL" -q -v secret="$SECRET" -f -

OUT="backups/INVOICE_READER_DATABASE_URL.txt"
umask 077
printf 'INVOICE_READER_DATABASE_URL=postgresql://invoice_reader.%s:%s@%s/postgres\n' \
  "$REF" "$SECRET" "$HOST" > "$OUT"
chmod 600 "$OUT"

echo
echo "==> verifying the new credential works AND is properly constrained"
CONN=$(grep -o 'postgresql://[^ ]*' "$OUT")
unset SECRET

psql "$CONN" -At -c "SELECT 'connected as ' || current_user;"
psql "$CONN" -At -c "
SELECT 'products readable: ' || string_agg(column_name, ', ' ORDER BY ordinal_position)
FROM information_schema.columns
WHERE table_name='products'
  AND has_column_privilege(current_user,'products',column_name,'SELECT');"
psql "$CONN" -At -c "
SELECT 'invoice query rows = ' || count(*)
FROM orders o JOIN products p ON p.id = o.product_id
LEFT JOIN events e ON e.name = o.event
WHERE lower(replace(o.customer,'@','')) = 'summerfey';"

echo
echo "==> margin must be refused for this role (an error here is the CORRECT result)"
psql "$CONN" -At -c "SELECT cost FROM products LIMIT 1;" 2>&1 | head -2

echo
echo "-------------------------------------------------------------------"
echo "Put the line in $OUT into Railway as INVOICE_READER_DATABASE_URL,"
echo "redeploy, then delete that file."
echo "-------------------------------------------------------------------"
