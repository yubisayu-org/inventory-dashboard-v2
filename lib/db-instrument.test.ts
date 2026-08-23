import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "./db-pool"
import { withQueryStats } from "./db-instrument"

after(async () => { await sql.end() })

test("a tagged query is counted and timed", async () => {
  const { stats } = await withQueryStats(async () => {
    await sql`SELECT pg_sleep(0.2)`
  })
  assert.equal(stats.count, 1)
  assert.ok(stats.slowest >= 200, `slowest was ${stats.slowest}`)
})

test("sql.unsafe is counted too — it is a query like any other", async () => {
  // Pagination and column filters build their SQL as a string, so the busiest
  // read paths (customers, payments) reach the database ONLY through unsafe.
  // Missing it reported their query time as application time, which pointed
  // the investigation at the wrong layer entirely.
  const { stats } = await withQueryStats(async () => {
    await sql.unsafe("SELECT pg_sleep(0.2)")
  })
  assert.equal(stats.count, 1)
  assert.ok(stats.slowest >= 200, `slowest was ${stats.slowest}`)
})

test("unsafe carries its parameters through unharmed", async () => {
  const rows = await sql.unsafe("SELECT $1::int AS n", [7])
  assert.equal(rows[0].n, 7)
})

test("building a query does not run it", async () => {
  const q = sql`SELECT pg_sleep(5)`
  assert.equal((q as unknown as { executed: boolean }).executed, false)
  q.catch(() => {})
})
