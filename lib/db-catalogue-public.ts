import postgres from "postgres"

// Dedicated connection for the PUBLIC, no-login catalogue endpoints
// (app/api/public/catalogue/*). Uses the `catalogue_public` role — scoped to
// visible posts, public-safe product columns, and the requester's own rows
// in catalogue_requests (see supabase/migrations/059_catalogue_public_role.sql)
// — so this path can never read cost/profit data or another customer's
// requests even if a query is wrong.
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
