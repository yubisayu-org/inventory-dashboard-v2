import { test } from "node:test"
import assert from "node:assert/strict"
import { FIXTURES } from "./fixtures"
import { locateInPost } from "./locate"

test("finds the item a customer cropped to, from a screenshot", async () => {
  // The fixture is the worst realistic input: a screenshot of a zoomed view, so
  // it is double-compressed, upscaled, and a different aspect to the original.
  const found = await locateInPost(FIXTURES.original, FIXTURES.crop)
  assert.ok(found, "expected a match")
  assert.equal(found.kind, "crop")

  // Ground truth: the pale green floral pyjama set — see __fixtures__/README.md.
  assert.ok(Math.abs(found.centre.x - 0.615) < 0.08, `centre.x was ${found.centre.x}`)
  assert.ok(Math.abs(found.centre.y - 0.231) < 0.08, `centre.y was ${found.centre.y}`)
})

test("a crop match is confident and unambiguous", async () => {
  const found = await locateInPost(FIXTURES.original, FIXTURES.crop)
  assert.ok(found)
  assert.ok(found.score > 0.85, `score was ${found.score}`)
  assert.ok(found.score - found.runnerUp > 0.15, `margin was ${found.score - found.runnerUp}`)
})

test("the whole photo sent back is a repost, not a crop", async () => {
  // ticked.jpg is the full frame — same content, WhatsApp-resized. It should be
  // recognised as pointing at the post rather than at any item within it.
  const found = await locateInPost(FIXTURES.original, FIXTURES.ticked)
  assert.ok(found, "expected a match")
  assert.equal(found.kind, "repost")
})

test("an unrelated image matches nothing", async () => {
  // The crop as its own scene: a 723x683 close-up cannot contain the shelf.
  const found = await locateInPost(FIXTURES.crop, FIXTURES.original)
  assert.equal(found, null)
})
