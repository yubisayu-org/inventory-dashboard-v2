#!/usr/bin/env bash
# Steps 2 and 3 against PRODUCTION. Same hardcoded URL as the step-1 script,
# so there is no shell variable to forget. Secret is generated here and never
# printed to the terminal.
set -euo pipefail
cd "$(dirname "$0")/.."

URL="postgresql://postgres.aihubvlvxukiiymhzewh@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"

if [ -z "${SUPABASE_DB_PASSWORD:-}" ]; then
  read -rsp "Supabase DB password (inventory-dashboard-prod): " SUPABASE_DB_PASSWORD; echo
fi
export PGPASSWORD="$SUPABASE_DB_PASSWORD"

echo "==> confirming step 1 actually landed on production"
psql "$URL" -At -c "
SELECT 'tables_created=' || count(*) FROM pg_tables
 WHERE schemaname='public' AND tablename IN
 ('catalogue_posts','wa_posts','dispatch_routes','announcements','customer_shipping_prefs');
SELECT 'catalogue_public_role=' || COALESCE(
  (SELECT CASE WHEN rolcanlogin THEN 'exists,LOGIN' ELSE 'exists,NOLOGIN' END
     FROM pg_roles WHERE rolname='catalogue_public'), 'MISSING');
SELECT 'margin_leaking=' ||
  (has_column_privilege('invoice_reader','products','cost','SELECT') OR
   has_column_privilege('invoice_reader','products','profit_pct','SELECT'));"

echo
if ! psql "$URL" -At -c "SELECT 1 FROM pg_roles WHERE rolname='catalogue_public'" | grep -q 1; then
  echo "STOP: catalogue_public role is missing on production."
  echo "That means migration 059 did not apply. Do not continue - re-check step 1."
  exit 1
fi

echo "==> step 2: setting catalogue_public password"
# hex, not base64: the secret goes into a connection URL, and / + = would need
# percent-encoding there. 64 hex chars is 256 bits, plenty.
SECRET=$(openssl rand -hex 32)
# psql only interpolates :'var' from a file or stdin, never from -c. Feed it on
# stdin so the secret never lands in shell history or the process list.
printf "ALTER ROLE catalogue_public WITH LOGIN PASSWORD :'secret';\n" \
  | psql "$URL" -q -v secret="$SECRET" -f -

OUTFILE="backups/CATALOGUE_PUBLIC_DATABASE_URL.txt"
umask 077
printf 'CATALOGUE_PUBLIC_DATABASE_URL=postgresql://catalogue_public.aihubvlvxukiiymhzewh:%s@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres\n' "$SECRET" > "$OUTFILE"
unset SECRET
chmod 600 "$OUTFILE"
echo "    secret written to $OUTFILE (mode 600, gitignored)"
echo "    copy that line into your production env, then delete the file"

echo "==> confirming the new credential actually logs in"
CHECK=$(grep -o 'postgresql://[^ ]*' "$OUTFILE")
if psql "$CHECK" -At -c "SELECT 'login ok as '||current_user;" 2>&1 | grep -q 'login ok'; then
  psql "$CHECK" -At -c "SELECT 'login ok as '||current_user;"
  psql "$CHECK" -At -c "SELECT 'products columns visible: '||string_agg(column_name,', ')
    FROM information_schema.columns WHERE table_name='products'
      AND has_column_privilege('catalogue_public','products',column_name,'SELECT');"
else
  echo "    WARNING: could not log in with the new credential - check the URL in $OUTFILE"
fi

echo
echo "==> step 3: verification"
psql "$URL" -f backups/deploy-step3-verify.sql
