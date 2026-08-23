#!/usr/bin/env bash
# Apply migrations 058-107 to production in ONE transaction.
# Prompts for the password; never takes it as an argument, never logs it.
set -euo pipefail
cd "$(dirname "$0")/.."

URL="postgresql://postgres.aihubvlvxukiiymhzewh@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"
BUNDLE="backups/deploy-058-107.sql"
[ -f "$BUNDLE" ] || { echo "missing $BUNDLE"; exit 1; }

if [ -z "${SUPABASE_DB_PASSWORD:-}" ]; then
  read -rsp "Supabase DB password (inventory-dashboard-prod): " SUPABASE_DB_PASSWORD; echo
fi

echo "==> preflight: confirming production is still at 057"
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql "$URL" -At -c \
  "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='catalogue_posts')
          THEN 'ALREADY PARTIALLY APPLIED - STOP' ELSE 'at 057, ok to proceed' END;"

echo
read -rp "Apply 48 migrations to PRODUCTION now? type 'yes': " ok
[ "$ok" = "yes" ] || { echo "aborted"; exit 1; }

# ON_ERROR_STOP plus the bundle's own BEGIN/COMMIT: any failure rolls back everything.
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql "$URL" -v ON_ERROR_STOP=1 -f "$BUNDLE"

echo
echo "==> applied."
echo "    next: backups/deploy-step2-role-password.sql  (set catalogue_public secret)"
echo "    then: backups/deploy-step3-verify.sql         (10 assertions, all must read OK)"
