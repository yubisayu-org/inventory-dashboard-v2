import { test } from "node:test"
import assert from "node:assert/strict"
import { FIXTURES } from "./fixtures"
import { loadRgb } from "./raster"
import { hueHistogram, safePenHues, HUE_BUCKETS, PEN_COLOURS } from "./hue"

test("histogram has one bucket per ten degrees", async () => {
  const raster = await loadRgb(FIXTURES.original, 240)
  const histogram = hueHistogram(raster)
  assert.equal(histogram.length, HUE_BUCKETS)
  assert.ok(histogram.every((n) => Number.isInteger(n) && n >= 0))
})

test("the shelf photo registers its red signage", async () => {
  const raster = await loadRgb(FIXTURES.original, 240)
  const histogram = hueHistogram(raster)
  // The shop's red PRICE DOWN sign lives in the first bucket (0-10 degrees).
  // This is the collision that makes red pen unusable on this photo.
  assert.ok(histogram[0] > 0, "expected vivid red pixels in the shelf photo")
})

test("the shelf photo contains no pen-green at all", async () => {
  const raster = await loadRgb(FIXTURES.original, 240)
  const histogram = hueHistogram(raster)
  // Buckets 12..14 cover 120-150 degrees, where WhatsApp's green pen sits.
  const green = histogram[12] + histogram[13] + histogram[14]
  assert.equal(
    green,
    0,
    "baby clothes are not pen-green; a non-zero count means the vividness threshold is too loose",
  )
})

test("green is offered as a safe pen for this photo and red is not", async () => {
  const raster = await loadRgb(FIXTURES.original, 240)
  const histogram = hueHistogram(raster)
  const safe = safePenHues(histogram, raster.width * raster.height).map((c) => c.name)
  assert.ok(safe.includes("green"), "green must be safe — the photo has none")
  assert.ok(!safe.includes("red"), "red must be rejected — the photo's signage is red")
})

test("an empty histogram makes every pen colour safe", () => {
  const safe = safePenHues(new Array(HUE_BUCKETS).fill(0), 100_000)
  assert.equal(safe.length, PEN_COLOURS.length)
})
