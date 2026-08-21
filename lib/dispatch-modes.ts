/**
 * How a dispatched parcel travelled, read off the front of its receipt.
 *
 * The code is typed by hand at dispatch time, so this is a convention rather
 * than a constraint: HC went in a suitcase, CJI flew as cargo, MNC came by
 * sea. Anything else — or nothing at all — is "other", deliberately visible
 * rather than hidden, because an unrecognised prefix is usually a typo worth
 * seeing.
 *
 * Its own file, not lib/db/dispatch.ts, because the receiving screen is a
 * client component: importing a value from lib/db would pull the postgres
 * driver into the browser bundle.
 */

/**
 * `warnDays` is when a box stops being merely slow and becomes worth chasing;
 * `lateDays` is when it is a problem. Both are counted from the day it left.
 *
 * Air and sea are the owner's own numbers — air 4 then 8 weeks, sea 8 then 12.
 * Hand carry has no stated pair: a suitcase either lands with the person or it
 * did not travel, so the window is short by nature. 1 then 2 weeks is a guess,
 * and the only one here.
 */
export const DISPATCH_MODES = {
  hc: { label: "Hand carry", prefix: "HC", warnDays: 7, lateDays: 14 },
  cji: { label: "Air cargo", prefix: "CJI", warnDays: 28, lateDays: 56 },
  mnc: { label: "Sea cargo", prefix: "MNC", warnDays: 56, lateDays: 84 },
} as const

export type DispatchMode = keyof typeof DISPATCH_MODES | "other"

/** green while it is travelling normally, amber worth chasing, red a problem. */
export type TransitStatus = "ontime" | "warn" | "late"

/** Which mode a receipt belongs to. Case and surrounding space are ignored. */
export function dispatchModeOf(receipt: string): DispatchMode {
  const head = receipt.trim().toUpperCase()
  // Longest prefix first: no overlap today, but this stays correct if a future
  // code ever begins with another's letters.
  for (const key of ["cji", "mnc", "hc"] as const) {
    if (head.startsWith(DISPATCH_MODES[key].prefix)) return key
  }
  return "other"
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
 * A parcel with no date reads as on time rather than late. Lines dispatched
 * before the date was recorded would otherwise sit red forever, and a warning
 * that is always on is one nobody looks at.
 */
export function transitStatus(
  mode: DispatchMode, dispatchedAt: string, today = new Date(),
): TransitStatus {
  const days = daysInTransit(dispatchedAt, today)
  if (days === null || mode === "other") return "ontime"
  const { warnDays, lateDays } = DISPATCH_MODES[mode]
  if (days > lateDays) return "late"
  if (days > warnDays) return "warn"
  return "ontime"
}
