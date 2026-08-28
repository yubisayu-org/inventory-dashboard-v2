import { test } from "node:test"
import assert from "node:assert/strict"

/**
 * The list of items a refund message names.
 *
 * Extracted from RefundsClient so the rule can be tested without a browser.
 * Keep the two in step: this is the logic, that is the wiring.
 */
function namedItems(note: string, unavailable: string[], needsItems: boolean): string[] {
  const noteLines = note.split("\n").map((l) => l.replace(/^[-•]\s*/, "").trim()).filter(Boolean)
  const named = [...noteLines]
  if (needsItems) {
    // A note may name items in full, or abbreviate them: "Cooling Towel,
    // Bucket Hat, Simple Cap — 5 item" is how a person summarises five marks
    // merged into one refund, and none of the real product names starts with
    // it. Matching whole lines appended every item again and she was sent the
    // list twice.
    //
    // So compare fragments. A note line is cut on commas and dashes, and a
    // fragment of four characters or more that appears inside a product name
    // counts as having named it. Short fragments are ignored: "Cap" would
    // swallow "Simple Cap" and hide it.
    const fragments = noteLines
      .flatMap((l) => l.split(/[,;·—–-]|\s×\s/))
      .map((f) => f.trim().toLowerCase())
      .filter((f) => f.length > 3)
    for (const item of unavailable) {
      const name = item.toLowerCase()
      const already = fragments.some((f) => name.includes(f) || f.includes(name))
      if (!already) named.push(item)
    }
  }
  return named
}

const FIVE = [
  "PCM Cooling Towel Blue",
  "Bottle Case with Shoulder Black",
  "Stainless Steel Wire Tongs",
  "Bucket Hat with String",
  "Simple Cap",
]

test("a note summarising the items does not make them all print twice", () => {
  // lydouble25's real note after the nine rows were corrected by hand. It names
  // every item in shortened form, and a prefix test matched none of them — so
  // she was sent the summary and then the same five items underneath it.
  const note = "Cooling Towel, Bucket Hat, Simple Cap, Bottle Case, Wire Tongs — 5 item"
  assert.deepEqual(namedItems(note, FIVE, true), [note], "the note said it; nothing to add")
})

test("a note naming items in full does not repeat them either", () => {
  const note = FIVE.map((n) => `${n} × 1`).join("\n")
  assert.equal(namedItems(note, FIVE, true).length, 5)
})

test("an item the note misses is still named", () => {
  // The point of merging in the first place: one mark writes the note, and the
  // others would go unmentioned.
  const note = "PCM Cooling Towel Blue × 1"
  const out = namedItems(note, FIVE, true)
  assert.equal(out.length, 5)
  assert.ok(out.includes("Simple Cap"))
})

test("an overpayment's note is left alone", () => {
  // It says what the money was, not what was lost. Cancelled lines are none of
  // its business.
  const note = "Applied Rp 14000 as credit to LSKR202603"
  assert.deepEqual(namedItems(note, FIVE, false), [note])
})

test("a short note word does not swallow a real item", () => {
  // "Cap" is three letters; without the length floor it would match
  // "Simple Cap" and hide it.
  const out = namedItems("Cap", ["Simple Cap"], true)
  assert.deepEqual(out, ["Cap", "Simple Cap"])
})
