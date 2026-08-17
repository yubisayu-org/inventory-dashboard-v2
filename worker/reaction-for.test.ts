import { test } from "node:test"
import assert from "node:assert/strict"
import { CAPTURE_REACTIONS } from "./reactions"
import { reactionForClaims } from "./claims"

test("a mark that was placed is simply recorded", () => {
  assert.equal(
    reactionForClaims([{ source: "ink", point: { x: 0.3, y: 0.7 } }]),
    CAPTURE_REACTIONS.recorded,
  )
})

test("an unknown sender does not make the customer's claim look incomplete", () => {
  // The claim below is exactly what a stranger's perfect mark produces. Whether
  // the owner has met this person is the owner's problem; asking the customer
  // for a detail they cannot supply is not an answer to it.
  assert.equal(
    reactionForClaims([{ source: "ink", point: { x: 0.298, y: 0.666 } }]),
    CAPTURE_REACTIONS.recorded,
  )
})

test("a claim with no position asks a real question", () => {
  // The photo came back whole, or the crop could not be placed: the shelf is
  // known, the item is not.
  assert.equal(
    reactionForClaims([{ source: "repost", point: null }]),
    CAPTURE_REACTIONS.needsDetail,
  )
})

test("nothing understood asks for a retype", () => {
  assert.equal(reactionForClaims([]), CAPTURE_REACTIONS.unreadable)
})

test("one placed mark among several is enough to record", () => {
  assert.equal(
    reactionForClaims([
      { source: "ink", point: { x: 0.2, y: 0.2 } },
      { source: "repost", point: null },
    ]),
    CAPTURE_REACTIONS.recorded,
  )
})
