import { test } from "node:test"
import assert from "node:assert/strict"
import { isLiveAmount } from "./live-refund"

test("an overpayment still being decided is live", () => {
  for (const status of ["pending", "awaiting_bank_info", "ready_to_refund"]) {
    assert.equal(isLiveAmount({ reason: "overpayment", status }), true, status)
  }
})

test("a settled overpayment is frozen at what was settled", () => {
  for (const status of ["refunded", "cancelled"]) {
    assert.equal(isLiveAmount({ reason: "overpayment", status }), false, status)
  }
})

test("a deposit is a fixed sum on her account, not a claim on a balance", () => {
  // She chose to keep it. Where it came from stops mattering, and nothing
  // about it should move afterwards.
  assert.equal(isLiveAmount({ reason: "overpayment", status: "applied_to_next_order" }), false)
})

test("a goods refund is the price of a thing, so it never moves", () => {
  // The Bucket Hat is Rp 160.000 whether or not she orders ten more items.
  for (const reason of ["unavailable", "damaged", "quality", "shipping_loss", "wrong_item"]) {
    assert.equal(isLiveAmount({ reason, status: "pending" }), false, reason)
  }
})

test("an unrecognised reason is stored, never live", () => {
  // Production holds one whose reason is the literal string "Out of stock".
  // Guessing that it means `unavailable` would put a balance on a price.
  assert.equal(isLiveAmount({ reason: "Out of stock", status: "pending" }), false)
  assert.equal(isLiveAmount({ reason: "", status: "pending" }), false)
})
