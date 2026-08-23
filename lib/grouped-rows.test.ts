import { test } from "node:test"
import assert from "node:assert/strict"
import { groupItems, buildRows, rowKey } from "./grouped-rows"

type Item = { event: string; store: string; productId: number }
const it = (event: string, store: string, productId: number): Item => ({ event, store, productId })

/** Every row must account for exactly the table's column count. A rowSpan that
 *  outlives the rows beneath it pushes their cells sideways, which is the bug
 *  this guards. */
function spansMatchRows(rows: ReturnType<typeof buildRows<Item>>): boolean {
  let covered = 0
  for (const r of rows) {
    if (r.type === "event-collapsed") { covered = 0; continue }
    if (r.showEvent && r.eventRowSpan) covered = r.eventRowSpan
    covered -= 1
  }
  return covered === 0
}

test("a product ordered on two events, in one parcel from one store, keeps two rows", () => {
  // Under a route tab the top-level group is the PARCEL, so the event is no
  // longer part of the group key — it has to be part of the row key instead,
  // or the two rows collide and React renders one of them.
  const items = [it("POCN202607", "ZHONGGANG", 42), it("MU-19953", "ZHONGGANG", 42)]
  const grouped = groupItems(items, () => "MNC-29786")
  const rows = buildRows(grouped, new Set(), new Set())

  const keys = rows.flatMap((r) => (r.type === "item" ? [rowKey(r.event, r.store, r.item)] : []))
  assert.equal(keys.length, 2)
  assert.equal(new Set(keys).size, 2, "two different events must not share one row key")
})

test("the event rowSpan covers exactly the rows drawn beneath it", () => {
  const items = [it("POCN202607", "ZHONGGANG", 42), it("MU-19953", "ZHONGGANG", 42), it("MU-19953", "JINXIANG", 7)]
  const rows = buildRows(groupItems(items, () => "MNC-29786"), new Set(), new Set())
  assert.ok(spansMatchRows(rows), "a rowSpan longer than its rows shifts every row below it")
})

test("grouping by event keeps the old behaviour", () => {
  const items = [it("E1", "S1", 1), it("E1", "S1", 2), it("E2", "S1", 1)]
  const rows = buildRows(groupItems(items), new Set(), new Set())
  assert.equal(rows.filter((r) => r.type === "item").length, 3)
  assert.ok(spansMatchRows(rows))
})
