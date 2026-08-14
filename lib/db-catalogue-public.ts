import postgres from "postgres"

// Dedicated connection for the PUBLIC, no-login catalogue endpoints
// (app/api/public/catalogue/*). Uses the `catalogue_public` role, which enforces
// column-level grants: SELECT on (id, name, store, price) only on products
// (never cost/profit), and SELECT/INSERT on catalogue_requests
// (see supabase/migrations/059_catalogue_public_role.sql).
// NOTE: The role prevents reading product cost/profit (real DB-layer guarantee
// via column grants), but does NOT enforce per-customer row scoping on
// catalogue_requests — that responsibility lives in the API route's WHERE clause
// (WHERE customer_handle = $1), not in this connection or role.
const connectionString = process.env.CATALOGUE_PUBLIC_DATABASE_URL!

// Local dev DB (127.0.0.1) is plaintext; require SSL only for remote hosts.
const isLocalDb = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString)

const catalogueSql = postgres(connectionString, {
  max: 3,
  idle_timeout: 300,
  max_lifetime: 60 * 30,
  connect_timeout: 10,
  ssl: isLocalDb ? false : "require",
  prepare: false,
  connection: {
    statement_timeout: 15000,
  },
})

export default catalogueSql
