import { test } from "node:test"
import assert from "node:assert/strict"

/**
 * The list of items a refund message names, and what each cost.
 *
 * Extracted from RefundsClient so the rule can be exercised without a browser.
 * Keep the two in step: this is the logic, that is the wiring.
 */
type Line = { productName: string; rawUnitPrice: number }

const rp = (n: number) => `Rp ${n.toLocaleString("id-ID")}`

function namedItems(note: string, unavailable: Line[], needsItems: boolean): string[] {
  const noteLines = note.split("\n").map((l) => l.replace(/^[-•]\s*/, "").trim()).filter(Boolean)
  const fragments = noteLines
    .flatMap((l) => l.split(/[,;·—–]|\s×\s/))
    .map((f) => f.trim().toLowerCase())
    .filter((f) => f.length > 3)

  function qtyFor(name: string): number | null {
    for (const line of noteLines) {
      const m = line.match(/×\s*(\d+)/)
      if (!m) continue
      const before = line.slice(0, line.indexOf("×")).trim().toLowerCase()
      if (before && (name.toLowerCase().includes(before) || before.includes(name.toLowerCase()))) {
        return Number(m[1])
      }
    }
    return null
  }

  const named: string[] = []
  if (needsItems) {
    for (const line of unavailable) {
      const qty = qtyFor(line.productName)
      const each = line.rawUnitPrice
      const money = each > 0
        ? qty && qty > 1 ? ` — ${qty} × ${rp(each)} = ${rp(each * qty)}` : ` — ${rp(each)}`
        : ""
      named.push(`${line.productName}${qty && qty > 1 ? ` × ${qty}` : ""}${money}`)
    }
    for (const line of noteLines) {
      const known = unavailable.some((item) => {
        const name = item.productName.toLowerCase()
        return fragments.some((f) => name.includes(f) || f.includes(name))
      })
      if (!known) named.push(line)
    }
  } else {
    named.push(...noteLines)
  }
  return named
}

const FIVE: Line[] = [
  { productName: "PCM Cooling Towel Blue", rawUnitPrice: 182000 },
  { productName: "Bottle Case with Shoulder Black", rawUnitPrice: 149000 },
  { productName: "Stainless Steel Wire Tongs", rawUnitPrice: 144000 },
  { productName: "Bucket Hat with String", rawUnitPrice: 160000 },
  { productName: "Simple Cap", rawUnitPrice: 160000 },
]

test("one item per line, each with its price", () => {
  // lydouble25's real refund: five items merged into one row, and a note that
  // summarises them in shorthand.
  const note = "Cooling Towel, Bucket Hat, Simple Cap, Bottle Case, Wire Tongs — 5 item"
  assert.deepEqual(namedItems(note, FIVE, true), [
    "PCM Cooling Towel Blue — Rp 182.000",
    "Bottle Case with Shoulder Black — Rp 149.000",
    "Stainless Steel Wire Tongs — Rp 144.000",
    "Bucket Hat with String — Rp 160.000",
    "Simple Cap — Rp 160.000",
  ])
})

test("the summary line is not repeated underneath the items it summarises", () => {
  const note = "Cooling Towel, Bucket Hat, Simple Cap, Bottle Case, Wire Tongs — 5 item"
  assert.ok(!namedItems(note, FIVE, true).some((l) => l.includes("5 item")))
})

test("more than one of something shows the multiplication", () => {
  // She should not have to do the arithmetic to check it.
  const out = namedItems("Simple Cap × 3", [{ productName: "Simple Cap", rawUnitPrice: 160000 }], true)
  assert.deepEqual(out, ["Simple Cap × 3 — 3 × Rp 160.000 = Rp 480.000"])
})

test("a partial shortage still gets a line, since the order keeps no trace", () => {
  // Reduced 3 to 2: nothing on the invoice went to zero, so only the note knows.
  const out = namedItems("Muji Pen × 1", [], true)
  assert.deepEqual(out, ["Muji Pen × 1"])
})

test("an overpayment's note is passed through untouched", () => {
  const note = "Applied Rp 14000 as credit to LSKR202603"
  assert.deepEqual(namedItems(note, FIVE, false), [note])
})
