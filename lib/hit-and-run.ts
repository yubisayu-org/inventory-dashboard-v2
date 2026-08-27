// The wording of a walked-away-from order, and how it is read back.
//
// Deliberately free of any database import: the modal that writes the stamp and
// the pages that show it are client components, and reaching into lib/db for a
// string pulls postgres and node:async_hooks into the browser bundle.

/** The stamp a whole-order cancellation leaves on every line it zeroes. */
export const HIT_AND_RUN = "HIT & RUN"

/** Notes hold several facts, joined by this. */
export const NOTE_SEP = " · "

/** `HIT & RUN LSKR202507 Rp 710.000` — which trip, and what she never paid. */
export function hitAndRunStamp(event: string, unpaid: number): string {
  return `${HIT_AND_RUN} ${event} Rp ${Math.max(0, unpaid).toLocaleString("id-ID")}`
}

export function isHitAndRun(text: string): boolean {
  return text.includes(HIT_AND_RUN)
}
