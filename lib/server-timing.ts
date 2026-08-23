import type { NextRequest } from "next/server"
import { withQueryStats } from "./db-instrument"

type Handler<C> = (req: NextRequest, ctx: C) => Promise<Response>

/**
 * Wrap a route handler so its response carries a Server-Timing header.
 *
 * Read it in DevTools → Network → the request → Timing, or as a raw header:
 *
 *   Server-Timing: total;dur=812, db;dur=740;desc="6 queries", dbmax;dur=690, app;dur=72
 *
 *   total  — the whole handler, auth included
 *   db     — every query's duration added up
 *   dbmax  — the single slowest query
 *   app    — total minus the slowest query, i.e. the floor that is NOT the DB
 *
 * `app` is the number that settles the current argument. Large `db` and `dbmax`
 * means a query needs an index. Small `db` with large `app` means the DB is
 * innocent and the instance (or the payload) is the cost.
 */
export function withServerTiming<C>(handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    const started = performance.now()
    const { result, stats } = await withQueryStats(() => handler(req, ctx))
    const total = performance.now() - started

    const header = [
      `total;dur=${total.toFixed(0)}`,
      `db;dur=${stats.dbMs.toFixed(0)};desc="${stats.count} queries"`,
      `dbmax;dur=${stats.slowest.toFixed(0)}`,
      `app;dur=${Math.max(0, total - stats.slowest).toFixed(0)}`,
    ].join(", ")

    // A handler may return a Response whose headers are immutable (a redirect,
    // or one built from a frozen init). Timing is diagnostics — never let it
    // break the response it is measuring.
    try {
      result.headers.set("Server-Timing", header)
    } catch {
      // ignore
    }
    return result
  }
}
