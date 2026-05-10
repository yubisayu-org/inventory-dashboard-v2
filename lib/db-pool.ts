import postgres from "postgres"

const connectionString = process.env.DATABASE_URL!

const sql = postgres(connectionString, {
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

export default sql
