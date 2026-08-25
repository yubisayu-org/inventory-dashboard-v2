import { test } from "node:test"
import assert from "node:assert/strict"
import { rowsFromForm, type OrderFormLine } from "./order-rows"

const PRICES: Record<number, number> = { 7: 150000, 9: 90000 }
const priceOf = (id: number) => PRICES[id] ?? 0
const line = (l: Partial<OrderFormLine>): OrderFormLine =>
  ({ productId: "", customer: "", unit: "", note: "", ...l })

test("one customer, several items — the shape the form has always had", () => {
  const rows = rowsFromForm({
    mode: "byCustomer", event: "MU-1", fixed: "ninaa", priceOf,
    lines: [line({ productId: "7", unit: "2", note: "blue" }), line({ productId: "9", unit: "1" })],
  })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { event: "MU-1", customer: "ninaa", productId: 7, unitPrice: 150000, unit: 2, note: "blue" })
  assert.equal(rows[1].productId, 9)
  assert.ok(rows.every((r) => r.customer === "ninaa"))
})

test("one item, several customers — the transpose", () => {
  const rows = rowsFromForm({
    mode: "byItem", event: "MU-1", fixed: "7", priceOf,
    lines: [
      line({ customer: "ninaa", unit: "2" }),
      line({ customer: "budi", unit: "1", note: "size L" }),
      line({ customer: "sari", unit: "3" }),
    ],
  })
  assert.equal(rows.length, 3)
  assert.ok(rows.every((r) => r.productId === 7 && r.unitPrice === 150000 && r.event === "MU-1"))
  assert.deepEqual(rows.map((r) => [r.customer, r.unit]), [["ninaa", 2], ["budi", 1], ["sari", 3]])
  assert.equal(rows[1].note, "size L")
})

test("quantities stay with the person who asked for them", () => {
  // Getting this wrong bills the wrong customer, and nothing downstream would
  // notice: every row is individually valid.
  const rows = rowsFromForm({
    mode: "byItem", event: "E", fixed: "9", priceOf,
    lines: [line({ customer: "a", unit: "5" }), line({ customer: "b", unit: "1" })],
  })
  assert.equal(rows.find((r) => r.customer === "a")?.unit, 5)
  assert.equal(rows.find((r) => r.customer === "b")?.unit, 1)
})

test("a customer nobody has ordered for yet passes through untouched", () => {
  // appendOrders creates the customers row; the form must not mangle the handle.
  const rows = rowsFromForm({
    mode: "byItem", event: "E", fixed: "7", priceOf,
    lines: [line({ customer: "brand.new_handle", unit: "1" })],
  })
  assert.equal(rows[0].customer, "brand.new_handle")
})

test("an unknown product prices at zero rather than NaN", () => {
  const rows = rowsFromForm({
    mode: "byItem", event: "E", fixed: "404", priceOf,
    lines: [line({ customer: "a", unit: "1" })],
  })
  assert.equal(rows[0].unitPrice, 0)
})

test("blank lines are dropped, not submitted as empty orders", () => {
  const rows = rowsFromForm({
    mode: "byItem", event: "E", fixed: "7", priceOf,
    lines: [line({ customer: "a", unit: "1" }), line({}), line({ customer: "b", unit: "2" })],
  })
  assert.equal(rows.length, 2)
})
