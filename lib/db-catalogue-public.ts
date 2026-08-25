import postgres from "postgres"
import { instrument } from "./db-instrument"

// Dedicated connection for the PUBLIC, no-login catalogue endpoints
// (app/api/public/catalogue/*). Uses the `catalogue_public` role, which enforces
// column-level grants: SELECT on (id, name, store, price) only on products
// (never cost/profit), and SELECT/INSERT/UPDATE (status, updated_at) on
// catalogue_requests (see supabase/migrations/059_catalogue_public_role.sql
// and 079_custom_request_edit_approval.sql for the UPDATE grant).
// NOTE: The role prevents reading product cost/profit (real DB-layer guarantee
// via column grants), but does NOT enforce per-customer row scoping on
// catalogue_requests — that responsibility lives in the API route's WHERE clause
// (WHERE customer_handle = $1), not in this connection or role.
const connectionString = process.env.CATALOGUE_PUBLIC_DATABASE_URL!

// Local dev DB (127.0.0.1) is plaintext; require SSL only for remote hosts.
const isLocalDb = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString)

const catalogueSql = postgres(connectionString, {
  // Bumped 3 → 12. Three was set when this pool served a couple of read-only
  // endpoints; it now serves fifteen — every customer-facing route on the
  // catalogue, for every customer at once. The page's own boot fans out
  // several of them in parallel, and each authenticated one spends a
  // connection resolving the session BEFORE it spends one on the query.
  //
  // Past three concurrent queries the rest queue, and a queue wait is not
  // covered by connect_timeout or statement_timeout — those bound reaching the
  // database and running a query, not waiting for a slot. So the request
  // simply hangs, the catalogue's own 12s abort fires first, and it surfaces
  // as an AbortError on the caller with nothing logged here at all.
  //
  // lib/db-pool.ts carries the same scar: 5 → 10 → 20 after a 2026-08-12 burst
  // "queued past Railway's proxy timeout, requests never even erroring — just
  // queued waiting for a free connection". Same disease, and this pool was
  // left at three while the customer site grew on top of it.
  max: 12,
  idle_timeout: 300,
  max_lifetime: 60 * 30,
  connect_timeout: 10,
  ssl: isLocalDb ? false : "require",
  prepare: false,
  connection: {
    statement_timeout: 15000,
  },
})

export default instrument(catalogueSql, "catalogue_public")
