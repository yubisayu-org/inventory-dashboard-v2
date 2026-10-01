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
 * This file shipped on 8 Sep and never ran once in production. `next start`
 * installs its own SIGTERM handler, which drains HTTP and calls process.exit
 * before anything registered here gets a turn; the log line below appears in
 * none of the deployments since. Next only stands aside when
 * NEXT_MANUAL_SIG_HANDLE=true is set on the start script itself (not in a .env
 * file -- it is read before those load), which package.json now does. Standing
 * aside also means Next no longer exits for us, so this handler must, and it
 * gives up and exits anyway if a pool will not close in time: a container that
 * ignores SIGTERM is SIGKILLed by the platform, which is the very orphaning
 * this exists to prevent.
 *
 * Node-only, and imported dynamically from instrumentation.ts for that reason:
 * the Edge runtime has neither process signals nor pg sockets, and refuses to
 * compile a file that reaches for them.
 */
import sql from "./db-pool"
import catalogueSql from "./db-catalogue-public"
import publicSql from "./db-public"

let closing = false

/** 128 + the signal number, the convention Next's own handler follows. */
const EXIT_CODE: Record<string, number> = { SIGTERM: 143, SIGINT: 130 }

/** Longer than the pools' own 5s drain, shorter than Railway's kill grace. */
const HARD_DEADLINE_MS = 8_000

async function close(signal: string) {
  // A second signal while the first is still draining must not start again.
  if (closing) return
  closing = true
  console.log(`${signal}: closing database pools`)

  // If a pool hangs, exit regardless: staying alive past the platform's grace
  // period ends in SIGKILL, and then the sockets are orphaned after all.
  const deadline = setTimeout(() => {
    console.error("database pools did not close in time; exiting anyway")
    process.exit(EXIT_CODE[signal] ?? 128)
  }, HARD_DEADLINE_MS)
  deadline.unref()

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
  clearTimeout(deadline)
  process.exit(EXIT_CODE[signal] ?? 128)
}

process.once("SIGTERM", () => { void close("SIGTERM") })
process.once("SIGINT", () => { void close("SIGINT") })
