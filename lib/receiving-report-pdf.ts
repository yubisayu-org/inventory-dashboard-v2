import type { ReceivedReportItem } from "@/lib/db"
import {
  buildReportGroups,
  type ReportCopy,
  type ReportGroup,
  type ReportLayout,
} from "./receiving-report-groups"

// Brand red (matches --brand in globals.css), as RGB for jsPDF.
const BRAND: [number, number, number] = [0x7b, 0x1a, 0x1a]

export interface ReceivedReportData {
  event: string
  from: string | null // YYYY-MM-DD (inclusive); null = no date filter (all dates)
  to: string | null // YYYY-MM-DD (inclusive); equals `from` for a single day
  /** Parcel the report was narrowed to, if any — a prefix, so "MNC" is valid. */
  receipt?: string | null
  items: ReceivedReportItem[]
  totalUnits: number
  /** A page per parcel, or a page per shop. Defaults to the parcel. */
  layout?: ReportLayout
  /** Only meaningful per store: the staff copy withholds shop and receipts. */
  copy?: ReportCopy
}

// "25 Jun 2026" for a single day, "20 – 22 Jun 2026" / "29 Jun – 02 Jul 2026"
// for a range. Plain YYYY-MM-DD strings, formatted without timezone math.
function formatRange(from: string, to: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const parts = (d: string) => {
    const [y, m, day] = d.split("-").map(Number)
    return { y, m: months[m - 1] ?? "?", day }
  }
  const a = parts(from)
  const b = parts(to)
  const one = (p: { y: number; m: string; day: number }) => `${String(p.day).padStart(2, "0")} ${p.m} ${p.y}`
  if (from === to) return one(a)
  if (a.y === b.y && a.m === b.m) return `${String(a.day).padStart(2, "0")} – ${one(b)}`
  if (a.y === b.y) return `${String(a.day).padStart(2, "0")} ${a.m} – ${one(b)}`
  return `${one(a)} – ${one(b)}`
}

// A4 portrait, millimetres.
const PAGE_W = 210
const PAGE_H = 297
const MARGIN = 14
const BOTTOM = PAGE_H - MARGIN - 8 // the footer sits in the last 8mm

// Columns, right to left. The tick box closes every table: counting against the
// paper is what the paper is for, and a report you cannot mark gets marked in
// the margin anyway.
const TICK_SIZE = 4
const TICK_X = PAGE_W - MARGIN - TICK_SIZE
const COL_UNITS_R = TICK_X - 5
// The left column carries the store (per box) or the boxes (per store). A staff
// copy has neither, and hands the width to the product.
const KEY_X = MARGIN
const KEY_W = 38
const PRODUCT_X_OWNER = MARGIN + 42
const PRODUCT_X_STAFF = MARGIN
const PRODUCT_PAD = 12 // keeps a long name off the units column

const LINE_H = 5

/**
 * Build the printable "Items Received" report as a PDF Blob.
 *
 * Two layouts, chosen at download time: a page per parcel for unpacking, or a
 * page per shop for handing over. Each group starts a new page — a pile shared
 * with another pile is worse at the packing table than an extra sheet.
 *
 * The grouping itself lives in receiving-report-groups.ts and is tested there;
 * everything here is drawing. Mirrors the client-side jsPDF approach in
 * lib/shipping-label.ts (hand-drawn table, no autotable dependency).
 */
export async function generateReceivedReport({
  event,
  from,
  to,
  receipt,
  items,
  totalUnits,
  layout = "per-box",
  copy = "owner",
}: ReceivedReportData): Promise<Blob> {
  const { default: jsPDF } = await import("jspdf")
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" })

  const staff = copy === "staff"
  const productX = staff ? PRODUCT_X_STAFF : PRODUCT_X_OWNER
  const productW = COL_UNITS_R - PRODUCT_PAD - productX

  // Date subtitle: the range when given, else "All dates".
  const dateText = from && to ? formatRange(from, to) : "All dates"

  // Which group each page belongs to, so footers can be drawn at the end —
  // "Page 3 of 7" is not knowable until the last row is placed.
  const pageLabels: string[] = []
  let y = MARGIN

  function header() {
    doc.setTextColor(...BRAND)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(16)
    doc.text("YUBISAYU", MARGIN, y + 4)
    doc.setFontSize(13)
    // The parcel belongs in the title when one was asked for: a report of one
    // box and a report of the whole trip otherwise look identical on paper.
    doc.text(`Items Received · ${event}${receipt ? ` · ${receipt.toUpperCase()}` : ""}`, MARGIN, y + 11)

    doc.setTextColor(80)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(11)
    doc.text(dateText, PAGE_W - MARGIN, y + 11, { align: "right" })

    doc.setDrawColor(...BRAND)
    doc.setLineWidth(0.4)
    doc.line(MARGIN, y + 14, PAGE_W - MARGIN, y + 14)
    y += 20
  }

  /** The thing that earned this page: a receipt, a shop, or a batch number. */
  function groupHeading(group: ReportGroup) {
    doc.setTextColor(30)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(15)
    doc.text(group.heading, MARGIN, y + 5)

    doc.setTextColor(120)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9.5)
    doc.text(group.meta, PAGE_W - MARGIN, y + 5, { align: "right" })
    y += 11
  }

  function columnHeads() {
    doc.setTextColor(120)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8.5)
    if (!staff) doc.text(layout === "per-store" ? "RECEIPT" : "STORE", KEY_X, y)
    doc.text("PRODUCT", productX, y)
    doc.text("UNITS", COL_UNITS_R, y, { align: "right" })
    // Drawn, not typed: helvetica's WinAnsi encoding has no check mark, and an
    // unencodable character prints as a stray tick of punctuation.
    doc.setDrawColor(120)
    doc.setLineWidth(0.35)
    doc.line(TICK_X + 0.5, y - 1.5, TICK_X + 1.5, y - 0.5)
    doc.line(TICK_X + 1.5, y - 0.5, TICK_X + 3.5, y - 3)
    y += 2
    doc.setDrawColor(220)
    doc.setLineWidth(0.2)
    doc.line(MARGIN, y, PAGE_W - MARGIN, y)
    y += 4
  }

  function bodyType() {
    doc.setTextColor(30)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(10)
  }

  const groups = buildReportGroups(items, layout, copy)

  if (groups.length === 0) {
    header()
    columnHeads()
    doc.setTextColor(120)
    doc.setFont("helvetica", "italic")
    doc.setFontSize(11)
    doc.text("No items were received in this period.", MARGIN, y + 4)
    return doc.output("blob")
  }

  groups.forEach((group, index) => {
    // Every group starts a page. The first one is already on it.
    if (index > 0) doc.addPage()
    y = MARGIN
    pageLabels.push(group.label)
    header()
    groupHeading(group)
    columnHeads()
    bodyType()

    for (const line of group.lines) {
      const productLines = doc.splitTextToSize(line.product, productW) as string[]
      const rowH = Math.max(productLines.length, line.key.length, 1) * LINE_H

      // Page break before drawing a row that would overflow. The heading is not
      // repeated — the page footer carries it, and a second heading would read
      // as a second group.
      if (y + rowH > BOTTOM) {
        doc.addPage()
        y = MARGIN
        pageLabels.push(group.label)
        header()
        columnHeads()
        bodyType()
      }

      if (line.key.length > 0) {
        doc.setTextColor(105)
        doc.text(doc.splitTextToSize(line.key.join("\n"), KEY_W) as string[], KEY_X, y + 3.5)
        doc.setTextColor(30)
      }
      doc.text(productLines, productX, y + 3.5)
      doc.text(String(line.units), COL_UNITS_R, y + 3.5, { align: "right" })
      doc.setDrawColor(185)
      doc.setLineWidth(0.2)
      doc.roundedRect(TICK_X, y + 0.4, TICK_SIZE, TICK_SIZE, 0.6, 0.6, "S")

      y += rowH + 1
      doc.setDrawColor(235)
      doc.setLineWidth(0.1)
      doc.line(MARGIN, y - 0.5, PAGE_W - MARGIN, y - 0.5)
    }

    // Subtotal, always with its group.
    y += 2
    doc.setDrawColor(200)
    doc.setLineWidth(0.3)
    doc.line(MARGIN, y, PAGE_W - MARGIN, y)
    y += 6
    doc.setTextColor(30)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(10.5)
    doc.text(`Subtotal · ${group.label}`, productX, y)
    doc.text(String(group.subtotal), COL_UNITS_R, y, { align: "right" })
  })

  // Grand total, on the last page only.
  y += 4
  if (y + 8 > BOTTOM) {
    doc.addPage()
    y = MARGIN
    pageLabels.push(pageLabels.at(-1) ?? "")
  }
  doc.setDrawColor(...BRAND)
  doc.setLineWidth(0.4)
  doc.line(MARGIN, y, PAGE_W - MARGIN, y)
  y += 6
  doc.setFont("helvetica", "bold")
  doc.setFontSize(11)
  doc.setTextColor(...BRAND)
  doc.text("TOTAL UNITS RECEIVED", productX, y)
  doc.text(String(totalUnits), COL_UNITS_R, y, { align: "right" })

  // Footers last: the page count is only known now, and sheets get separated on
  // the packing table, so each one has to say which group it belongs to.
  const pages = doc.getNumberOfPages()
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page)
    doc.setDrawColor(235)
    doc.setLineWidth(0.15)
    doc.line(MARGIN, PAGE_H - MARGIN - 5, PAGE_W - MARGIN, PAGE_H - MARGIN - 5)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8.5)
    doc.setTextColor(150)
    doc.text(pageLabels[page - 1] ?? "", MARGIN, PAGE_H - MARGIN)
    doc.text(`Page ${page} of ${pages}`, PAGE_W - MARGIN, PAGE_H - MARGIN, { align: "right" })
  }

  return doc.output("blob")
}
