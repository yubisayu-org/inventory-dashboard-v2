/**
 * Close the database pools before the container dies.
 *
 * Railway sends SIGTERM and then kills. Without this the sockets to Supabase's
 * pooler were never closed: Postgres kept the backends, blocked trying to hand
 * results back to a process that no longer existed, and they held their pooler
 * slots until something upstream reaped them. On 8 Sep 2026 three deploys in
 * five minutes left sixteen of those behind, the pooler ran out of slots, and
 * for a quarter of an hour every page answered "Failed to load payment status"
 * or timed out -- with nothing wrong in the database at all.
 *
 * Node-only, and imported dynamically from instrumentation.ts for that reason:
 * the Edge runtime has neither process signals nor pg sockets, and refuses to
 * compile a file that reaches for them.
 */
import sql from "./db-pool"
import catalogueSql from "./db-catalogue-public"
import publicSql from "./db-public"

let closing = false

async function close(signal: string) {
  // A second signal while the first is still draining must not start again.
  if (closing) return
  closing = true
  console.log(`${signal}: closing database pools`)
  // `end({ timeout })` finishes what is in flight, then closes; the timeout is
  // a ceiling, not a wait, so an idle pool closes at once. Settled separately,
  // so one slow pool cannot hold the others open and one that throws does not
  // abandon the rest.
  const results = await Promise.allSettled([
    sql.end({ timeout: 5 }),
    catalogueSql.end({ timeout: 5 }),
    publicSql.end({ timeout: 5 }),
  ])
  for (const r of results) {
    if (r.status === "rejected") console.error("A pool did not close cleanly:", r.reason)
  }
  console.log("database pools closed")
}

process.once("SIGTERM", () => { void close("SIGTERM") })
process.once("SIGINT", () => { void close("SIGINT") })
