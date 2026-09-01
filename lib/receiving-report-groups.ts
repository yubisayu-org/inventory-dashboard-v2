import type { ReceivedReportItem } from "@/lib/db"

/**
 * Turning the received tally into pages.
 *
 * The report answers one of two questions, and they want different paper:
 *
 *   per-box    one page per parcel, read while it is being cut open
 *   per-store  one page per pile, handed to whoever packs
 *
 * The per-store sheet exists to be given away, so it comes in two copies. The
 * owner copy names the shop and the boxes. The staff copy names neither: the
 * shop because where the goods were bought is not the packer's business, and
 * the receipts because they carry the route and the shipping arrangement. What
 * is left -- product, count, tick box -- is exactly what picking needs.
 *
 * Withholding the shop is partial by nature: most product names carry their own
 * brand ("Muji Gel Pen 0.38 Black") and no flag can take that out. What it does
 * protect is the minority where the shop is NOT the brand -- a Nintendo bought
 * at Bic Camera, anything from a marketplace seller -- and those are the rows
 * that actually say something about sourcing.
 *
 * Drawing lives in receiving-report-pdf.ts. This module is pure so the grouping
 * can be tested without a PDF.
 */

export type ReportLayout = "per-box" | "per-store"
export type ReportCopy = "owner" | "staff"

/** Receipts printed in a cell before the remainder collapses to "+N more". */
export const BOX_LIST_CAP = 3

/** Stands in for a receipt or store that was never filled in. */
export const NO_KEY = "—"

export interface ReportLine {
  /**
   * The left column, as printed lines. One entry for a store; one per box for
   * a product that arrived split. Empty on a staff copy, which has no left
   * column at all.
   */
  key: string[]
  product: string
  units: number
}

export interface ReportGroup {
  /** The page heading: a receipt, a store, or "BATCH 3 OF 7". */
  heading: string
  /** Printed beside the heading. */
  meta: string
  /** Printed in the subtotal row and the page footer -- shorter than heading. */
  label: string
  lines: ReportLine[]
  subtotal: number
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Blank keys sort last; everything else alphabetically. */
function byKey(a: string, b: string): number {
  if (a === b) return 0
  if (!a) return 1
  if (!b) return -1
  return a.localeCompare(b, "en")
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const bucket = out.get(k)
    if (bucket) bucket.push(item)
    else out.set(k, [item])
  }
  return out
}

/**
 * "CJI-2607 · 5", one per line, capped so a product that toured the whole
 * shipment cannot swallow a page.
 */
function boxLines(items: ReceivedReportItem[]): string[] {
  const sorted = [...items].sort((a, b) => byKey(a.dispatchReceipt, b.dispatchReceipt))
  const shown = sorted.slice(0, BOX_LIST_CAP).map((i) =>
    sorted.length === 1
      ? (i.dispatchReceipt || NO_KEY)
      : `${i.dispatchReceipt || NO_KEY} · ${i.unitsReceived}`,
  )
  const hidden = sorted.length - shown.length
  return hidden > 0 ? [...shown, `+${hidden} more`] : shown
}

function sum(items: ReceivedReportItem[]): number {
  return items.reduce((n, i) => n + i.unitsReceived, 0)
}

/**
 * One page per parcel. The query already returns one row per (product, box), so
 * a product cannot appear twice on the same page and nothing needs merging.
 */
function perBox(items: ReceivedReportItem[], copy: ReportCopy): ReportGroup[] {
  const boxes = [...groupBy(items, (i) => i.dispatchReceipt)].sort((a, b) => byKey(a[0], b[0]))

  return boxes.map(([receipt, rows]) => {
    const sorted = [...rows].sort(
      (a, b) => byKey(a.store, b.store) || a.productName.localeCompare(b.productName, "en"),
    )
    const heading = receipt || NO_KEY
    const units = sum(rows)
    return {
      heading,
      label: heading,
      meta: `${plural(sorted.length, "line")} · ${plural(units, "unit")}`,
      lines: sorted.map((r) => ({
        key: copy === "staff" ? [] : [r.store || NO_KEY],
        product: r.productName,
        units: r.unitsReceived,
      })),
      subtotal: units,
    }
  })
}

/**
 * One page per shop. A product bought at one shop but split across boxes comes
 * back as several rows; here it becomes ONE line at its true total, with the
 * boxes and their counts kept in the left column -- a shortage is traced by box
 * and by nothing else.
 *
 * On a staff copy there is no left column, which settles the same question by
 * removing it: the line is simply the product and its total.
 */
function perStore(items: ReceivedReportItem[], copy: ReportCopy): ReportGroup[] {
  const stores = [...groupBy(items, (i) => i.store)].sort((a, b) => byKey(a[0], b[0]))

  return stores.map(([store, rows], index) => {
    // Same product across two boxes is one line. Keyed on the id, since two
    // distinct products can share a name.
    const products = [...groupBy(rows, (r) => String(r.productId))]
      .map(([, group]) => group)
      .sort((a, b) => a[0].productName.localeCompare(b[0].productName, "en"))

    const units = sum(rows)
    // A line with no receipt on it is not a box — counting it as one would
    // claim a parcel that never existed.
    const boxCount = new Set(rows.map((r) => r.dispatchReceipt).filter(Boolean)).size
    const staff = copy === "staff"

    return {
      // The pile, not the shop. Numbered in the order the pages already sort,
      // so batch 5 is always the fifth pile made.
      heading: staff ? `BATCH ${index + 1} OF ${stores.length}` : (store || NO_KEY),
      label: staff ? `Batch ${index + 1}` : (store || NO_KEY),
      // The staff copy does not count boxes either -- how many parcels a trip
      // took is the same kind of fact as which parcel this came in.
      meta:
        staff || boxCount === 0
          ? `${plural(products.length, "line")} · ${plural(units, "unit")}`
          : `${plural(boxCount, "box", "boxes")} · ${plural(products.length, "line")}`,
      lines: products.map((group) => ({
        key: staff ? [] : boxLines(group),
        product: group[0].productName,
        units: sum(group),
      })),
      subtotal: units,
    }
  })
}

export function buildReportGroups(
  items: ReceivedReportItem[],
  layout: ReportLayout,
  copy: ReportCopy,
): ReportGroup[] {
  return layout === "per-store" ? perStore(items, copy) : perBox(items, copy)
}
