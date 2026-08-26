import { test } from "node:test"
import assert from "node:assert/strict"
import { isCreditPromised } from "./refund-credit"

const promise = { status: "applied_to_next_order", refundAmount: 60_000, appliedCreditAmount: 0 }

test("she asked to keep it and nothing has moved yet", () => {
  assert.equal(isCreditPromised(promise), true)
})

test("a credit that was actually applied is finished", () => {
  // applyRefundAsCredit consumes the amount and records what it moved.
  assert.equal(isCreditPromised({ ...promise, refundAmount: 0, appliedCreditAmount: 60_000 }), false)
})

test("a part-applied credit is not a promise — someone has already acted on it", () => {
  assert.equal(isCreditPromised({ ...promise, refundAmount: 20_000, appliedCreditAmount: 40_000 }), false)
})

test("no other status is a promise, whatever is owed on it", () => {
  for (const status of ["pending", "awaiting_bank_info", "ready_to_refund", "refunded", "cancelled"]) {
    assert.equal(isCreditPromised({ ...promise, status }), false, status)
  }
})

test("nothing owed is nothing promised", () => {
  // Guards the empty case: a zero-amount row must not sit in Pending for ever.
  assert.equal(isCreditPromised({ ...promise, refundAmount: 0 }), false)
})
