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
  /** Stable and internal; the label and prefix are the owner's to change. */
  key: string
  label: string
  prefix: string
  /** How long this route usually takes — past this, a box is worth chasing. */
  warnDays: number
  /** Past this it is a problem rather than merely slow. */
  lateDays: number
}

/** What the app falls back to before Settings has been read. */
export const FALLBACK_ROUTES: DispatchRoute[] = [
  { key: "hc", label: "Hand carry", prefix: "HC", warnDays: 7, lateDays: 14 },
  { key: "cji", label: "Air cargo", prefix: "CJI", warnDays: 28, lateDays: 56 },
  { key: "mnc", label: "Sea cargo", prefix: "MNC", warnDays: 56, lateDays: 84 },
]

/** green while it is travelling normally, amber worth chasing, red a problem. */
export type TransitStatus = "ontime" | "warn" | "late"

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
  return [...routes]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((r) => head.startsWith(r.prefix.trim().toUpperCase())) ?? null
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
 * A parcel with no date, or on no known route, reads as on time rather than
 * late: lines dispatched before departure dates existed would otherwise sit red
 * for ever, and a warning that is always on is one nobody looks at.
 */
export function transitStatus(
  route: DispatchRoute | null, dispatchedAt: string, today = new Date(),
): TransitStatus {
  const days = daysInTransit(dispatchedAt, today)
  if (days === null || !route) return "ontime"
  if (days > route.lateDays) return "late"
  if (days > route.warnDays) return "warn"
  return "ontime"
}
