import { test } from "node:test"
import assert from "node:assert/strict"
import { FIXTURES } from "./fixtures"
import { detectChanges } from "./diff"
import { detectMarks } from "./ink"
import { loadRgb } from "./raster"

test("marks are found without knowing what colour the pen was", async () => {
  const marks = await detectChanges(FIXTURES.original, FIXTURES.ticked)
  assert.equal(marks.length, 2, "the same two ticks the hue detector finds")
})

test("it succeeds where the hue detector cannot be trusted", async () => {
  // The real failure this was built for: the shelf photo already contains the
  // customer's pen colour, so safePenHues excludes it. Asking for the excluded
  // hues anyway shows why that exclusion exists — the photo's own contents come
  // back as dozens of spurious blobs, which is worse than finding nothing.
  const reply = await loadRgb(FIXTURES.ticked, 480)
  const wrongHues = detectMarks(reply, [0, 225, 280])
  assert.ok(
    wrongHues.length > 5,
    `expected the photo's own colours to flood the result, got ${wrongHues.length}`,
  )

  // Difference detection asks what changed instead of what colour a pixel is,
  // so it returns the two real ticks and nothing else.
  const byDifference = await detectChanges(FIXTURES.original, FIXTURES.ticked)
  assert.equal(byDifference.length, 2)
})

test("an unmarked copy of the post yields nothing", async () => {
  const marks = await detectChanges(FIXTURES.original, FIXTURES.original)
  assert.equal(marks.length, 0, "no change means no claim, not a claim at the origin")
})

test("a differently shaped reply is refused rather than stretched", async () => {
  // crop.jpg is a region of the shelf, so it fits the box at a different shape.
  // Subtracting it from the whole photo would be comparing two different scenes.
  const marks = await detectChanges(FIXTURES.original, FIXTURES.crop)
  assert.equal(marks.length, 0)
})

test("the marks land in the same places the hue detector reports", async () => {
  const reply = await loadRgb(FIXTURES.ticked, 480)
  const byHue = detectMarks(reply, [130]).map((m) => m.point)
  const byDiff = await detectChanges(FIXTURES.original, FIXTURES.ticked)

  for (const mark of byDiff) {
    const near = byHue.some(
      (p) => Math.hypot(p.x - mark.point.x, p.y - mark.point.y) < 0.05,
    )
    assert.ok(near, `no hue mark near ${JSON.stringify(mark.point)}`)
  }
})
