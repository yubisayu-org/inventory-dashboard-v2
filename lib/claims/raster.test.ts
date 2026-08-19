import { test } from "node:test"
import assert from "node:assert/strict"
import { FIXTURES } from "./fixtures"
import { loadRgb, loadGray, rgbToHsv } from "./raster"

test("rgbToHsv places primaries on the right hues", () => {
  assert.equal(Math.round(rgbToHsv(255, 0, 0).h), 0)
  assert.equal(Math.round(rgbToHsv(0, 255, 0).h), 120)
  assert.equal(Math.round(rgbToHsv(0, 0, 255).h), 240)
})

test("rgbToHsv reports greys as unsaturated", () => {
  const { s, v } = rgbToHsv(128, 128, 128)
  assert.equal(s, 0)
  assert.ok(Math.abs(v - 128 / 255) < 0.01)
})

test("rgbToHsv reports black without dividing by zero", () => {
  const { h, s, v } = rgbToHsv(0, 0, 0)
  assert.equal(h, 0)
  assert.equal(s, 0)
  assert.equal(v, 0)
})

test("loadRgb decodes to the requested width with three channels", async () => {
  const raster = await loadRgb(FIXTURES.ticked, 240)
  assert.equal(raster.width, 240)
  assert.ok(raster.height > 240, "the fixture is portrait, so height should exceed width")
  assert.equal(raster.data.length, raster.width * raster.height * 3)
})

test("loadGray decodes to one channel per pixel", async () => {
  const raster = await loadGray(FIXTURES.ticked, 240)
  assert.equal(raster.width, 240)
  assert.equal(raster.data.length, raster.width * raster.height)
})
