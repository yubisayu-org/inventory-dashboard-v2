import { test } from "node:test"
import assert from "node:assert/strict"
import { uncovered, residualExcluding, SMALL_OVERPAYMENT_IDR } from "./refund-residual"

test("nothing is uncovered when the invoice was paid exactly", () => {
  assert.equal(uncovered(500_000, 500_000, []), 0)
})

test("an overpayment with no refunds is uncovered in full", () => {
  assert.equal(uncovered(550_000, 500_000, []), 50_000)
})

test("a refund covering the whole overpayment leaves nothing", () => {
  // A mark refunded the sold-out item; the invoice fell by the same amount.
  assert.equal(uncovered(550_000, 300_000, [250_000]), 0)
})

test("a refund covering part of it leaves exactly the remainder", () => {
  // Sold-out item worth 200_000 refunded; she had also overpaid by 50_000.
  assert.equal(uncovered(550_000, 300_000, [200_000]), 50_000)
})

test("refunds beyond the overpayment never make it negative", () => {
  assert.equal(uncovered(550_000, 500_000, [80_000]), 0)
})

test("underpayment is not a refund", () => {
  assert.equal(uncovered(400_000, 500_000, []), 0)
})

test("a row reconciles to the residual that excludes itself", () => {
  // 250_000 over. A mark's row holds 200_000; the overpayment row should hold 50_000.
  const refunds = [{ id: 1, amount: 200_000 }, { id: 2, amount: 999 }]
  assert.equal(residualExcluding(550_000, 300_000, refunds, 2), 50_000)
})

test("excluding a row that is not there changes nothing", () => {
  const refunds = [{ id: 1, amount: 200_000 }]
  assert.equal(residualExcluding(550_000, 300_000, refunds, 99), 50_000)
})

test("the small-amount threshold is ten thousand rupiah", () => {
  assert.equal(SMALL_OVERPAYMENT_IDR, 10_000)
})
