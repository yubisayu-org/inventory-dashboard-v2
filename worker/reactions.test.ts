import { test } from "node:test"
import assert from "node:assert/strict"
import { CAPTURE_REACTIONS, OUTCOME_REACTIONS, ReactionQueue } from "./reactions"

test("the vocabulary is the one the spec fixed", () => {
  assert.equal(CAPTURE_REACTIONS.recorded, "📝")
  assert.equal(CAPTURE_REACTIONS.needsDetail, "❔")
  assert.equal(CAPTURE_REACTIONS.unreadable, "😢")
  assert.equal(OUTCOME_REACTIONS.secured, "✅")
  assert.equal(OUTCOME_REACTIONS.missed, "❌")
})

test("reactions go out one at a time, never in a volley", async () => {
  const sent: number[] = []
  let inFlight = 0
  let overlapped = false

  const queue = new ReactionQueue(
    async () => {
      inFlight += 1
      if (inFlight > 1) overlapped = true
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      sent.push(sent.length)
    },
    // No jitter in the test: the pacing is the caller's concern, the ordering
    // is this class's.
    () => 0,
  )

  for (let i = 0; i < 5; i++) queue.push({ jid: "g@g.us", key: { id: String(i) }, emoji: "📝" })
  await queue.drain()

  assert.equal(sent.length, 5)
  assert.equal(overlapped, false, "a volley of reactions is the signature to avoid")
})

test("a failed reaction does not stop the ones behind it", async () => {
  let attempts = 0
  const queue = new ReactionQueue(async () => {
    attempts += 1
    if (attempts === 2) throw new Error("network")
  }, () => 0)

  for (let i = 0; i < 3; i++) queue.push({ jid: "g@g.us", key: { id: String(i) }, emoji: "📝" })
  await queue.drain()

  assert.equal(attempts, 3, "the queue keeps going after one fails")
})
