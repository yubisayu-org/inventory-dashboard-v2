/**
 * How a dispatched parcel travelled, read off the front of its receipt.
 *
 * The codes themselves live in Settings (the dispatch_routes table), because
 * they are the owner's naming: HC went in a suitcase, CJI flew as cargo, MNC
 * came by sea, and a forwarder change should not need a deploy. Everything
 * here takes the current routes as an argument rather than assuming them.
 *
 * Anything a prefix does not match is "other" — deliberately visible rather
 * than hidden, because an unrecognised code is usually a typo worth seeing.
 *
 * Its own file, not lib/db, because the receiving screen is a client
 * component: importing a value from lib/db would pull the postgres driver into
 * the browser bundle.
 */

export interface DispatchRoute {
  /** Stable and internal; the label and codes are the owner's to change. */
  key: string
  label: string
  /**
   * Every code that means this route. A forwarder books the same sea freight
   * under more than one series, and both belong to one tab rather than to a
   * second route wearing the same name.
   */
  prefixes: string[]
  /** How long this route usually takes — past this, a box is worth chasing. */
  warnDays: number
  /** Past this it is a problem rather than merely slow. */
  lateDays: number
}

/** What the app falls back to before Settings has been read. */
export const FALLBACK_ROUTES: DispatchRoute[] = [
  { key: "hc", label: "Hand Carry", prefixes: ["HC"], warnDays: 7, lateDays: 14 },
  { key: "air", label: "Air Cargo", prefixes: ["CJI"], warnDays: 28, lateDays: 56 },
  { key: "sea", label: "Sea Cargo", prefixes: ["MNC"], warnDays: 56, lateDays: 84 },
]

/**
 * green while it is travelling normally, amber worth chasing, red a problem —
 * and "unknown" when there is nothing to judge by: no departure date, or a
 * receipt whose code matches no route, which is what an old parcel written
 * "Box 1" looks like.
 */
export type TransitStatus = "unknown" | "ontime" | "warn" | "late"

/**
 * Which route a receipt belongs to, or null when nothing matches.
 *
 * Longest prefix first, so a route whose code begins with another's still
 * resolves to the more specific one rather than to whichever was checked
 * first. Settings refuses that overlap, but the reading should not depend on
 * the writing having been careful.
 */
export function routeOf(receipt: string, routes: DispatchRoute[]): DispatchRoute | null {
  const head = receipt.trim().toUpperCase()
  if (!head) return null
  // Flattened to (code, route) pairs first: with several codes per route, the
  // most specific code has to win across ALL routes, not merely against the
  // other codes of its own.
  return routes
    .flatMap((r) => r.prefixes.map((p) => ({ prefix: p.trim().toUpperCase(), route: r })))
    .filter((x) => x.prefix !== "")
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((x) => head.startsWith(x.prefix))?.route ?? null
}

/** The route's key, or "other". Convenient for grouping and tab keys. */
export function routeKeyOf(receipt: string, routes: DispatchRoute[]): string {
  return routeOf(receipt, routes)?.key ?? "other"
}

/** Whole days between a dispatch date and today. Null when the date is absent. */
export function daysInTransit(dispatchedAt: string, today = new Date()): number | null {
  if (!dispatchedAt) return null
  const sent = new Date(`${dispatchedAt}T00:00:00`)
  if (Number.isNaN(sent.getTime())) return null
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.max(0, Math.round((midnight.getTime() - sent.getTime()) / 86_400_000))
}

/**
 * How a parcel is doing against the window its route usually needs.
 *
 * "unknown" rather than "ontime" when there is no date or no route. Both were
 * green once, which read as a promise the data could not make: a parcel called
 * "Box 1" at 25 days is unremarkable by sea and hopeless in a suitcase, and
 * nothing here can tell which. Green is a claim; grey is the truth.
 *
 * It is deliberately not red either — an old parcel that predates route codes
 * is not evidence of a problem, and a warning that is always on is one nobody
 * looks at.
 */
export function transitStatus(
  route: DispatchRoute | null, dispatchedAt: string, today = new Date(),
): TransitStatus {
  const days = daysInTransit(dispatchedAt, today)
  if (days === null || !route) return "unknown"
  if (days > route.lateDays) return "late"
  if (days > route.warnDays) return "warn"
  return "ontime"
}
