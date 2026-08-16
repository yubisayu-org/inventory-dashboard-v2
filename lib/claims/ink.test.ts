import { test } from "node:test"
import assert from "node:assert/strict"
import { FIXTURES } from "./fixtures"
import { loadRgb } from "./raster"
import { hueHistogram, safePenHues } from "./hue"
import { detectMarks } from "./ink"

const GREEN = [130]

test("finds exactly the two ticks a customer drew", async () => {
  const raster = await loadRgb(FIXTURES.ticked, 480)
  const marks = detectMarks(raster, GREEN)
  assert.equal(marks.length, 2, `expected 2 marks, got ${marks.length}`)
})

test("the marks land where the customer put them", async () => {
  const raster = await loadRgb(FIXTURES.ticked, 480)
  const marks = detectMarks(raster, GREEN)
  const sorted = [...marks].sort((a, b) => a.point.x - b.point.x)

  // Ground truth measured by hand — see __fixtures__/README.md.
  assert.ok(Math.abs(sorted[0].point.x - 0.244) < 0.04, `left mark x was ${sorted[0].point.x}`)
  assert.ok(Math.abs(sorted[0].point.y - 0.789) < 0.04, `left mark y was ${sorted[0].point.y}`)
  assert.ok(Math.abs(sorted[1].point.x - 0.414) < 0.04, `right mark x was ${sorted[1].point.x}`)
  assert.ok(Math.abs(sorted[1].point.y - 0.767) < 0.04, `right mark y was ${sorted[1].point.y}`)
})

test("an unmarked photo yields nothing", async () => {
  const raster = await loadRgb(FIXTURES.original, 480)
  const marks = detectMarks(raster, GREEN)
  assert.equal(marks.length, 0, "the unmarked original must produce no marks at all")
})

test("a hue the photo is full of produces false marks — which is why hues are chosen per post", async () => {
  const raster = await loadRgb(FIXTURES.original, 480)
  // Red is exactly the pen colour safePenHues rejects for this photo. Asserting
  // the failure keeps the reason for that machinery visible.
  const marks = detectMarks(raster, [0])
  assert.ok(marks.length > 0, "expected the red signage to be picked up when red is wrongly trusted")
})

test("safe hues from the post drive detection end to end", async () => {
  const post = await loadRgb(FIXTURES.original, 240)
  const safe = safePenHues(hueHistogram(post), post.width * post.height).map((c) => c.hue)

  const reply = await loadRgb(FIXTURES.ticked, 480)
  const marks = detectMarks(reply, safe)
  assert.equal(marks.length, 2)
})

/** A grey field with one solid block of colour, for testing hue maths alone. */
function swatch(r: number, g: number, b: number) {
  const width = 40
  const height = 40
  const data = new Uint8Array(width * height * 3).fill(128)
  for (let y = 10; y < 25; y++) {
    for (let x = 10; x < 25; x++) {
      const i = (y * width + x) * 3
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
    }
  }
  return { data, width, height }
}

test("hue matching wraps around the colour wheel", () => {
  // Regression: the circular-distance test was written inverted, so it matched
  // hues OPPOSITE the requested one. Two fixture tests passed anyway, for the
  // wrong reason — asking for red found the photo's cyan.
  //
  // Synthetic rather than a fixture on purpose: a shelf photo contains every
  // hue somewhere, so it cannot tell "matched the right hue" from "matched
  // something else that happened to be there".
  const red = swatch(255, 10, 10) // hue ~0

  assert.equal(detectMarks(red, [355]).length, 1, "355 and 0 are five degrees apart")
  assert.equal(detectMarks(red, [5]).length, 1, "5 is within tolerance of 0")
  assert.equal(detectMarks(red, [180]).length, 0, "the opposite hue must never match")
  assert.equal(detectMarks(red, [40]).length, 0, "40 degrees away is outside tolerance")
})

test("hue matching honours its tolerance", () => {
  const green = swatch(100, 255, 140) // hue ~134

  assert.equal(detectMarks(green, [130]).length, 1)
  assert.equal(detectMarks(green, [112]).length, 1, "22 degrees away is inside tolerance")
  assert.equal(detectMarks(green, [95]).length, 0, "39 degrees away is outside tolerance")
})

test("marks come back largest first", async () => {
  const raster = await loadRgb(FIXTURES.ticked, 480)
  const marks = detectMarks(raster, GREEN)
  assert.ok(marks[0].pixels >= marks[1].pixels)
})
