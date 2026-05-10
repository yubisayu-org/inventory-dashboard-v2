import postgres from "postgres"

const connectionString = process.env.DATABASE_URL!

const sql = postgres(connectionString, {
  max: 5,
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  connect_timeout: 10,
  ssl: "require",
  // Supabase's transaction-mode pooler (port 6543) reuses connections across
  // requests and doesn't support prepared statements. Disabling prepares
  // avoids "prepared statement does not exist" (SQLSTATE 26000) errors.
  prepare: false,
})

export default sql
