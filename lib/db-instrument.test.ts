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

// ── the ceiling ─────────────────────────────────────────────────────────────
// A pool of one, so a second query has to queue behind the first. That queue
// is where production spent eighteen minutes on 29 Sep 2026: the pooler had no
// backend to give, the driver waited politely, and no timeout on either side
// applied because nothing was executing.
import postgres from "postgres"
import { instrument } from "./db-instrument"

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")
const raw = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, ssl: isLocal ? false : "require" })
const tiny = instrument(raw, "tiny", { ceilingMs: 1000 })
// Same pool, same single connection, no ceiling: what a query that is
// genuinely stuck looks like, so the one queued behind it has to give up on
// its own rather than be rescued when the hog is cancelled first.
const patient = instrument(raw, "patient", { ceilingMs: 0 })
after(async () => { await raw.end({ timeout: 2 }) })

test("a query that runs past the ceiling is cancelled, not waited for", async () => {
  const t0 = performance.now()
  await assert.rejects(tiny`SELECT pg_sleep(5)`, (e: { code?: string }) => e.code === "57014")
  assert.ok(performance.now() - t0 < 4000, "should have given up long before pg_sleep finished")
})

test("a query still queued for a connection is given up on too", async () => {
  // Occupy the only connection with something nothing will cancel for us.
  const hogQuery = patient`SELECT pg_sleep(5)`
  const hog = hogQuery.catch(() => {})
  await new Promise((r) => setTimeout(r, 50))
  const t0 = performance.now()
  await assert.rejects(tiny`SELECT 1`, (e: { code?: string }) => e.code === "57014")
  assert.ok(performance.now() - t0 < 4000, "queued query should not wait for the hog")
  ;(hogQuery as unknown as { cancel: () => void }).cancel()
  await hog
})

test("a query under the ceiling is untouched", async () => {
  const rows = await tiny`SELECT 1 AS one`
  assert.equal(rows[0].one, 1)
})
