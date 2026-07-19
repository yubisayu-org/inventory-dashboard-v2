import postgres from "postgres"

const connectionString = process.env.DATABASE_URL!

// Reuse one pool across dev HMR reloads. Without this, every recompile that
// touches a module importing lib/db* re-runs this file and stacks a fresh
// pool on top of the old one's lingering sockets — eventually pressuring the
// Supabase pooler's client limit, whose dropped/killed connections surface as
// nonsense intermittent errors (result rows missing columns) until the dev
// server is restarted. Production runs this once, so the guard is a no-op.
const globalForDb = globalThis as unknown as { __dbPool?: ReturnType<typeof postgres> }

const sql = globalForDb.__dbPool ?? postgres(connectionString, {
  // Bumped from 5 → 10 because pages like the dashboard fan out 6 queries
  // in parallel via Promise.all and could starve the pool with multiple tabs.
  max: 10,
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  connect_timeout: 10,
  ssl: "require",
  // Supabase's transaction-mode pooler (port 6543) reuses connections across
  // requests and doesn't support prepared statements. Disabling prepares
  // avoids "prepared statement does not exist" (SQLSTATE 26000) errors.
  prepare: false,
  // Hard 15s ceiling on individual queries. A poorly-indexed query no longer
  // holds a connection forever — it fails fast and the pool stays healthy.
  connection: {
    statement_timeout: 15000,
  },
})

if (process.env.NODE_ENV !== "production") globalForDb.__dbPool = sql

export default sql
