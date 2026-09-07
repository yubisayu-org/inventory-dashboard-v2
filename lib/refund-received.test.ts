import { test } from "node:test"
import assert from "node:assert/strict"
import { substitutesFor } from "./refund-received"

// LSCN202606, as it stands in production: six wrong deliveries across the trip,
// belonging to six customers.
const TRIP = {
  "011508 Loose Dress Butter Yellow": "011508 Loose Dress White",
  "011509 Loose Shirt Butter Yellow": "011509 Loose Shirt White",
  "050504 Summer Short Pants Black XXL": "050504 Summer Short Pants Black XL",
  "B823 Feragamong Bag EW Beige": "B823 Feragamong Bag EW Pink",
  "C23604 Mono Heels Nude 41": "C23604 Mono Heels Nude 40",
  "D0304 Mary Jane Buckle Mules White 39": "D0304 Mary Jane Buckle Mules White 38",
}

test("one customer hears about her own item, not the whole trip", () => {
  // noi_laban's refund note, verbatim.
  const note = "B823 Feragamong Bag EW Beige × 1 × Rp 962.000"
  assert.equal(substitutesFor(note, TRIP), "B823 Feragamong Bag EW Pink")
})

test("a refund covering two lines names both substitutes", () => {
  const note = [
    "C23604 Mono Heels Nude 41 × 1 × Rp 500.000",
    "011509 Loose Shirt Butter Yellow × 2 × Rp 300.000",
  ].join("\n")
  assert.equal(
    substitutesFor(note, TRIP),
    "011509 Loose Shirt White, C23604 Mono Heels Nude 40",
  )
})

test("nothing of hers went wrong, so nothing is named", () => {
  // The caller's wording then drops to the sentence that names no substitute,
  // which is better than naming somebody else's parcel.
  assert.equal(substitutesFor("Some Other Item × 1 × Rp 10.000", TRIP), "")
  assert.equal(substitutesFor("", TRIP), "")
  assert.equal(substitutesFor("B823 Feragamong Bag EW Beige × 1", {}), "")
})

test("one substitute standing for two lines is said once", () => {
  const note = [
    "B823 Feragamong Bag EW Beige × 1 × Rp 962.000",
    "B823 Feragamong Bag EW Beige × 1 × Rp 962.000",
  ].join("\n")
  assert.equal(substitutesFor(note, TRIP), "B823 Feragamong Bag EW Pink")
})
