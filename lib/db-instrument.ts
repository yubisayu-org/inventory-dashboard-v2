import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Per-request DB accounting, so "production feels sluggish" becomes a number.
 *
 * Two independent halves, because they answer different questions:
 *
 *   - `instrument(sql)` wraps a pool and logs any single query slower than
 *     SLOW_QUERY_MS to stdout. Works everywhere — route handlers AND server
 *     component renders — because it hooks the driver, not the request.
 *   - `withQueryStats()` + lib/server-timing.ts add a Server-Timing header to
 *     a route handler's response, readable in DevTools. Needs an explicit
 *     wrapper: Next 16 has no per-request hook (instrumentation.ts only
 *     exposes `register` and `onRequestError`, and proxy.ts — the renamed
 *     middleware — runs before the handler, so it cannot know the DB cost).
 */

export type QueryStats = {
  /** Queries that completed inside the request. */
  count: number
  /** Sum of every query's duration. Parallel queries double-count against wall
   *  clock on purpose: the sum is the DB work, `slowest` is the wall cost of
   *  a Promise.all fan-out. Compare the two to tell a slow query from many. */
  dbMs: number
  /** Duration of the single slowest query in the request. */
  slowest: number
}

const stats = new AsyncLocalStorage<QueryStats>()

/** Log any query at or above this, in ms. 0 disables the log entirely. */
const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS ?? 300)

/** The SQL text only — never the parameters, which carry customer data. */
function sqlText(strings: readonly string[] | undefined): string {
  if (!strings) return "(unknown)"
  const text = strings.join(" ? ").replace(/\s+/g, " ").trim()
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

/**
 * Time one Query without executing it.
 *
 * postgres.js Query is a lazy Promise: `then`/`catch`/`finally`/`execute` all
 * funnel through `handle()`, which is what actually sends the query. Calling
 * `.then()` here to observe completion would therefore FIRE every query the
 * moment it is built, including ones the caller only meant to construct. So we
 * shadow two instance members instead — `handle` for the start stamp (it is
 * idempotent, guarded by `this.executed`) and the constructor-assigned
 * `resolve`/`reject` for the end stamp. Nothing runs that would not have run.
 */
function track(query: unknown, label: string): unknown {
  const q = query as {
    handle?: () => unknown
    resolve?: (x: unknown) => unknown
    reject?: (x: unknown) => unknown
    strings?: readonly string[]
  }
  if (typeof q.handle !== "function" || typeof q.resolve !== "function") return query

  let start: number | undefined
  const bucket = stats.getStore()

  const handle = q.handle.bind(q)
  q.handle = () => {
    if (start === undefined) start = performance.now()
    return handle()
  }

  const finish = () => {
    if (start === undefined) return
    const ms = performance.now() - start
    start = undefined
    if (bucket) {
      bucket.count++
      bucket.dbMs += ms
      if (ms > bucket.slowest) bucket.slowest = ms
    }
    if (SLOW_QUERY_MS > 0 && ms >= SLOW_QUERY_MS) {
      console.warn(`[slow-query] ${label} ${ms.toFixed(0)}ms — ${sqlText(q.strings)}`)
    }
  }

  const resolve = q.resolve.bind(q)
  const reject = q.reject!.bind(q)
  q.resolve = (x: unknown) => (finish(), resolve(x))
  q.reject = (x: unknown) => (finish(), reject(x))

  return query
}

/**
 * Wrap a postgres.js pool so every tagged-template query is timed.
 *
 * Only tagged-template calls are Queries. `sql(value)`, `sql(obj, ...keys)` and
 * friends return interpolation builders with no lifecycle, and are passed
 * straight through. Queries issued inside `sql.begin(tx => …)` use the driver's
 * own transaction handle, not this proxy, so they are counted only as the one
 * outer call — transactions here are writes, not the read paths under suspicion.
 */
export function instrument<T extends object>(sql: T, label: string): T {
  return new Proxy(sql, {
    apply(target, thisArg, args: unknown[]) {
      const out = Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args)
      const first = args[0] as { raw?: unknown } | undefined
      const isTagged = Array.isArray(first) && Array.isArray(first.raw)
      return isTagged ? track(out, label) : out
    },
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

/** Run `fn` with a fresh accounting bucket and hand back both. */
export async function withQueryStats<T>(fn: () => Promise<T>): Promise<{ result: T; stats: QueryStats }> {
  const bucket: QueryStats = { count: 0, dbMs: 0, slowest: 0 }
  const result = await stats.run(bucket, fn)
  return { result, stats: bucket }
}
