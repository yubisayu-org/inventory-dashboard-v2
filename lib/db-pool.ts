import postgres from "postgres"

const connectionString = process.env.DATABASE_URL!

const sql = postgres(connectionString, {
  max: 1,
  idle_timeout: 20,
  max_lifetime: 60,
})

export default sql
