import { test } from "node:test"
import assert from "node:assert/strict"
import { FIXTURES } from "./fixtures"
import { resolveImageReply } from "./index"

test("a marked reply resolves to its marks", async () => {
  const result = await resolveImageReply(FIXTURES.original, FIXTURES.ticked)
  assert.equal(result.kind, "marks")
  if (result.kind !== "marks") return
  assert.equal(result.marks.length, 2)
})

test("a cropped reply resolves to a located region", async () => {
  const result = await resolveImageReply(FIXTURES.original, FIXTURES.crop)
  assert.equal(result.kind, "crop")
  if (result.kind !== "crop") return
  assert.ok(result.located.score > 0.85)
})

test("ink wins over location when a reply has both", async () => {
  // ticked.jpg is the whole frame AND carries marks. The marks are the claim;
  // the fact that it also matches the post as a repost is not interesting.
  const result = await resolveImageReply(FIXTURES.original, FIXTURES.ticked)
  assert.equal(result.kind, "marks")
})
