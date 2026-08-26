import { test } from "node:test"
import assert from "node:assert/strict"
import { owed } from "./refund-owed"

test("a customer who paid nothing is owed nothing", () => {
  // Their order shrank, so they owe less. Nothing comes back.
  assert.equal(owed(2, 100_000, 0, 300_000), 0)
})

test("a fully paid customer is owed what was removed", () => {
  // Paid 500_000 for five units; two removed, invoice now 300_000.
  assert.equal(owed(2, 100_000, 500_000, 300_000), 200_000)
})

test("a part-paid customer is owed only what they overpaid", () => {
  // Paid 350_000 against a 500_000 order. Two units removed leaves the invoice
  // at 300_000, so only 50_000 of their money is now surplus.
  assert.equal(owed(2, 100_000, 350_000, 300_000), 50_000)
})

test("a customer still short after the reduction is owed nothing", () => {
  assert.equal(owed(2, 100_000, 250_000, 300_000), 0)
})

test("removing nothing owes nothing", () => {
  assert.equal(owed(0, 100_000, 500_000, 500_000), 0)
})

test("a free item owes nothing however much was paid", () => {
  assert.equal(owed(3, 0, 500_000, 500_000), 0)
})
