import postgres from "postgres"

const connectionString = process.env.DATABASE_URL!

const sql = postgres(connectionString, {
  max: 5,
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  connect_timeout: 10,
  ssl: "require",
})

export default sql
