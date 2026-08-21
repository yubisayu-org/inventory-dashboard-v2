/**
 * How a dispatched parcel travelled, read off the front of its receipt.
 *
 * The code is typed by hand at dispatch time, so this is a convention rather
 * than a constraint: HC went in a suitcase, CJI flew as cargo, MNC came by
 * sea. Anything else — or nothing at all — is "other", deliberately visible
 * rather than hidden, because an unrecognised prefix is usually a typo worth
 * seeing.
 *
 * Its own file, not lib/db/dispatch.ts, because the dispatch screen is a
 * client component: importing a value from lib/db would pull the postgres
 * driver into the browser bundle.
 */
export const DISPATCH_MODES = {
  hc: { label: "Hand carry", prefix: "HC" },
  cji: { label: "Air cargo", prefix: "CJI" },
  mnc: { label: "Sea cargo", prefix: "MNC" },
} as const

export type DispatchMode = keyof typeof DISPATCH_MODES | "other"

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
