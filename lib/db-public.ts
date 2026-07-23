import postgres from "postgres"

// Dedicated connection for the PUBLIC, no-login invoice recap endpoint
// (app/api/public/invoice). It uses the `invoice_reader` role — SELECT-only and
// column-scoped (see supabase/migrations/018_invoice_reader_role.sql) — so this
// path can never read or write PII / bank data even if a query is wrong.
const connectionString = process.env.INVOICE_READER_DATABASE_URL!

const publicSql = postgres(connectionString, {
  // Low ceiling: this is a single read per request on a low-traffic path.
  max: 3,
  // Keep connections warm between bursts to cut reconnect churn (auth +
  // type-introspection re-runs). See lib/db-pool.ts for the full rationale.
  idle_timeout: 300,
  max_lifetime: 60 * 30,
  connect_timeout: 10,
  ssl: "require",
  // Same transaction-mode pooler constraint as the main pool.
  prepare: false,
  // Skip per-connection type introspection — it re-shipped catalog rows over
  // the pooler on every reconnect. This path only SELECTs built-in types.
  // See lib/db-pool.ts for the full rationale.
  fetch_types: false,
  connection: {
    statement_timeout: 15000,
  },
})

export default publicSql
