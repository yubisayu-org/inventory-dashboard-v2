/**
 * The shared column grid for the in-transit tables.
 *
 * Receiving and Dispatch each stack their own "customer order" table above
 * OverbuyTransitList, and the two read as one list — so their columns have to
 * agree. They did not: the fourth column was w-40 on Receiving and w-32 on the
 * overbuy table, and Qty was w-14 against w-20, so scrolled past the section
 * headings the same grid appeared to break in half.
 *
 * Declared once and imported, because three files each holding their own copy
 * of the same widths is what let them drift in the first place.
 *
 * Both tables are `table-fixed`, so these widths are what the browser uses —
 * content never renegotiates them. The unlisted third column takes whatever is
 * left, which is why Dispatch's five-column table still lines up on the right:
 * its product column simply absorbs the width Reason would have taken.
 */
export const TRANSIT_COL = {
  /** Trip, or the parcel when a route tab is open. */
  group: "w-44",
  store: "w-36",
  /** Receipt on Receiving, Reason on the overbuy table — same slot either way. */
  detail: "w-40",
  qty: "w-20",
  action: "w-10",
} as const
