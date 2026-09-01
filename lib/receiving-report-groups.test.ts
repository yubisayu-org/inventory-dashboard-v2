import { test } from "node:test"
import assert from "node:assert/strict"
import { buildReportGroups, BOX_LIST_CAP, NO_KEY } from "./receiving-report-groups"
import type { ReceivedReportItem } from "@/lib/db"

/**
 * The receiving report as paper: what earns a page, and what a staff copy is
 * allowed to say.
 */

const EVENT = "LSDM202604"
let nextId = 1

function row(
  store: string,
  productName: string,
  dispatchReceipt: string,
  unitsReceived: number,
  productId = nextId++,
): ReceivedReportItem {
  return { event: EVENT, dispatchReceipt, store, productId, productName, unitsReceived }
}

// One shop's product that arrived split across two boxes -- the case the whole
// merge rule exists for.
const GEL_PEN = 101
const items: ReceivedReportItem[] = [
  row("MUJI", "Muji Gel Pen 0.38 Black", "CJI-2607", 5, GEL_PEN),
  row("MUJI", "Muji Gel Pen 0.38 Black", "CJI-2610", 7, GEL_PEN),
  row("MUJI", "Muji Boston Bag 38L Black", "CJI-2612", 1),
  row("DAISO", "Daiso Storage Box Clear L", "CJI-2607", 2),
  row("BIC CAMERA", "Nintendo Switch 2 Joy-Con Pair", "CJI-2607", 2),
]

test("per box: one page per parcel, in receipt order", () => {
  const groups = buildReportGroups(items, "per-box", "owner")
  assert.deepEqual(groups.map((g) => g.heading), ["CJI-2607", "CJI-2610", "CJI-2612"])
  assert.deepEqual(groups.map((g) => g.subtotal), [9, 7, 1])
})

test("per box: the store is the left column, sorted by store then product", () => {
  const [first] = buildReportGroups(items, "per-box", "owner")
  assert.deepEqual(
    first.lines.map((l) => [l.key, l.product, l.units]),
    [
      [["BIC CAMERA"], "Nintendo Switch 2 Joy-Con Pair", 2],
      [["DAISO"], "Daiso Storage Box Clear L", 2],
      [["MUJI"], "Muji Gel Pen 0.38 Black", 5],
    ],
  )
})

test("per store: one page per shop, in store order", () => {
  const groups = buildReportGroups(items, "per-store", "owner")
  assert.deepEqual(groups.map((g) => g.heading), ["BIC CAMERA", "DAISO", "MUJI"])
  assert.deepEqual(groups.map((g) => g.subtotal), [2, 2, 13])
})

test("per store, owner: a split product is one line at its true total", () => {
  const muji = buildReportGroups(items, "per-store", "owner").find((g) => g.heading === "MUJI")!
  const pen = muji.lines.find((l) => l.product.includes("Gel Pen"))!
  assert.equal(pen.units, 12, "5 out of one box and 7 out of another read as 12")
  assert.equal(muji.lines.length, 2, "the product appears once, not once per box")
  assert.deepEqual(pen.key, ["CJI-2607 · 5", "CJI-2610 · 7"], "the boxes stay printed, with counts")
})

test("per store, owner: a product from a single box needs no count beside it", () => {
  const muji = buildReportGroups(items, "per-store", "owner").find((g) => g.heading === "MUJI")!
  const bag = muji.lines.find((l) => l.product.includes("Boston Bag"))!
  assert.deepEqual(bag.key, ["CJI-2612"], "one box, so the number would only repeat the units column")
})

test("per store, owner: a product spread over many boxes stops at the cap", () => {
  const spread = Array.from({ length: BOX_LIST_CAP + 2 }, (_, i) =>
    row("MUJI", "Muji Gel Pen 0.38 Black", `CJI-30${i + 1}`, 1, GEL_PEN),
  )
  const [muji] = buildReportGroups(spread, "per-store", "owner")
  assert.equal(muji.lines[0].key.length, BOX_LIST_CAP + 1, "the cap, plus the line that counts the rest")
  assert.equal(muji.lines[0].key.at(-1), "+2 more")
  assert.equal(muji.lines[0].units, BOX_LIST_CAP + 2, "capping the list never changes the total")
})

test("staff copy: no shop, no receipt, anywhere on the page", () => {
  const groups = buildReportGroups(items, "per-store", "staff")
  assert.deepEqual(groups.map((g) => g.heading), ["BATCH 1 OF 3", "BATCH 2 OF 3", "BATCH 3 OF 3"])
  assert.deepEqual(groups.map((g) => g.label), ["Batch 1", "Batch 2", "Batch 3"])

  const printed = JSON.stringify(groups)
  for (const secret of ["BIC CAMERA", "MUJI", "DAISO", "CJI-2607", "CJI-2610", "CJI-2612"]) {
    assert.ok(!printed.includes(secret), `${secret} must not reach the packing table`)
  }
})

test("staff copy: the batches follow the same store order as the owner copy", () => {
  const owner = buildReportGroups(items, "per-store", "owner")
  const staff = buildReportGroups(items, "per-store", "staff")
  // Batch 5 has to be the fifth pile made, or the sheet stops matching the room.
  assert.deepEqual(staff.map((g) => g.subtotal), owner.map((g) => g.subtotal))
})

test("staff copy: the meta line does not count boxes either", () => {
  const [batch] = buildReportGroups(items, "per-store", "staff")
  assert.equal(batch.meta, "1 line · 2 units")
  const [store] = buildReportGroups(items, "per-store", "owner")
  assert.equal(store.meta, "1 box · 1 line", "the owner is told how many parcels it took")
})

test("staff copy: nothing is dropped, only withheld", () => {
  const owner = buildReportGroups(items, "per-store", "owner")
  const staff = buildReportGroups(items, "per-store", "staff")
  const total = (gs: typeof owner) => gs.reduce((n, g) => n + g.subtotal, 0)
  assert.equal(total(staff), total(owner))
  assert.deepEqual(staff.map((g) => g.lines.length), owner.map((g) => g.lines.length))
})

test("a line with no receipt is not counted as a box", () => {
  const mixed = [
    row("MUJI", "Muji Boston Bag 38L Black", "CJI-2612", 1),
    row("MUJI", "Muji Shoulder Bag 9L Beige", "", 4),
  ]
  const [muji] = buildReportGroups(mixed, "per-store", "owner")
  assert.equal(muji.meta, "1 box · 2 lines", "the unlabelled line claims no parcel of its own")

  const noneLabelled = [row("MUJI", "Muji Shoulder Bag 9L Beige", "", 4)]
  const [orphan] = buildReportGroups(noneLabelled, "per-store", "owner")
  assert.equal(orphan.meta, "1 line · 4 units", "with no boxes at all, counting them says nothing")
})

test("a blank receipt or store still gets a page, and sorts last", () => {
  const withBlank = [...items, row("", "Unlabelled Find", "", 3)]
  const boxes = buildReportGroups(withBlank, "per-box", "owner")
  assert.equal(boxes.at(-1)!.heading, NO_KEY, "no receipt is a page, not a silent omission")
  const stores = buildReportGroups(withBlank, "per-store", "owner")
  assert.equal(stores.at(-1)!.heading, NO_KEY)
})

test("two products sharing a name are not merged into one line", () => {
  const clash = [
    row("MUJI", "Muji Gel Pen 0.38 Black", "CJI-2607", 5, 201),
    row("MUJI", "Muji Gel Pen 0.38 Black", "CJI-2607", 7, 202),
  ]
  const [muji] = buildReportGroups(clash, "per-store", "owner")
  assert.equal(muji.lines.length, 2, "merging is by product id, since a name is not an identity")
})

test("nothing received is no pages at all", () => {
  assert.deepEqual(buildReportGroups([], "per-box", "owner"), [])
  assert.deepEqual(buildReportGroups([], "per-store", "staff"), [])
})
