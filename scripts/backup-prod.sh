#!/usr/bin/env bash
# Backup production Supabase (inventory-dashboard-prod) before a deploy.
# Password is read from the terminal, never passed as an argument, never logged.
set -euo pipefail

cd "$(dirname "$0")/.."
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="backups/prod-$STAMP"
mkdir -p "$OUT"

if [ -z "${SUPABASE_DB_PASSWORD:-}" ]; then
  read -rsp "Supabase DB password (inventory-dashboard-prod): " SUPABASE_DB_PASSWORD
  echo
fi
export SUPABASE_DB_PASSWORD

echo "==> 1/4 roles"
supabase db dump --linked --role-only -f "$OUT/roles.sql"

echo "==> 2/4 schema"
supabase db dump --linked -f "$OUT/schema.sql"

echo "==> 3/4 data"
supabase db dump --linked --data-only -f "$OUT/data.sql"

echo "==> 4/4 full custom-format dump (restore with pg_restore)"
PGPASSWORD="$SUPABASE_DB_PASSWORD" pg_dump \
  --no-owner --no-privileges --format=custom \
  --file="$OUT/full.dump" \
  "postgresql://postgres.aihubvlvxukiiymhzewh@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres" \
  || echo "   (skipped: pg_dump 18 vs server 17 mismatch — the three .sql files above are the real backup)"

echo
echo "==> row counts at backup time"
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql -At \
  "postgresql://postgres.aihubvlvxukiiymhzewh@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres" \
  -c "SELECT relname||' = '||n_live_tup FROM pg_stat_user_tables WHERE schemaname='public' AND n_live_tup > 0 ORDER BY relname" \
  | tee "$OUT/rowcounts.txt"

echo
ls -lh "$OUT"
echo "backup complete: $OUT"
