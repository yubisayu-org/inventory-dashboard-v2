import { test } from "node:test"
import assert from "node:assert/strict"
import { owed } from "./refund-owed"

test("a customer who paid nothing is owed nothing", () => {
  // Her order shrank, so she owes less. Nothing comes back.
  assert.equal(owed(200_000, 0, 300_000), 0)
})

test("a fully paid customer is owed what the reduction cost her", () => {
  // Paid 500_000; the reduction took the invoice to 300_000.
  assert.equal(owed(200_000, 500_000, 300_000), 200_000)
})

test("a part-paid customer is owed only what she overpaid", () => {
  // Paid 350_000 against a 500_000 order. The reduction leaves the invoice at
  // 300_000, so only 50_000 of her money is now surplus.
  assert.equal(owed(200_000, 350_000, 300_000), 50_000)
})

test("a customer still short after the reduction is owed nothing", () => {
  assert.equal(owed(200_000, 250_000, 300_000), 0)
})

test("removing nothing owes nothing", () => {
  assert.equal(owed(0, 500_000, 500_000), 0)
})

test("the ongkir the goods were carrying comes back with them", () => {
  // Goods 300_000 and the kilo they occupied at 25_000: the invoice fell by
  // 325_000, and that is the refund. Billing her for weight the parcel no
  // longer carries, then leaving the difference in To check, was the bug.
  assert.equal(owed(325_000, 1_100_000, 775_000), 325_000)
})

test("an unrelated overpayment stays out of this refund", () => {
  // She transferred 200_000 too much for reasons of her own. The reduction
  // cost her 100_000, so that is all this refund claims -- the rest is still
  // hers to explain, in To check.
  assert.equal(owed(100_000, 700_000, 400_000), 100_000)
})

test("a reduction that costs her nothing owes nothing", () => {
  // A free item, or one whose removal the rounding absorbed.
  assert.equal(owed(0, 500_000, 500_000), 0)
})
