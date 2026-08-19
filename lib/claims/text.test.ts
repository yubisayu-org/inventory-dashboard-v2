import { test } from "node:test"
import assert from "node:assert/strict"
import { parseVariantNote, resolveText } from "./text"

const NOTE = "warna: hitam/merah/putih\nsize: 38-42"

test("a note expands into every combination", () => {
  const { dimensions, variants } = parseVariantNote(NOTE)
  assert.deepEqual(dimensions.warna, ["hitam", "merah", "putih"])
  assert.deepEqual(dimensions.size, ["38", "39", "40", "41", "42"])
  assert.equal(variants.length, 15)
})

test("resolves a complete claim", () => {
  const { dimensions, variants } = parseVariantNote(NOTE)
  const claim = resolveText("hitam 38", variants, dimensions)
  assert.equal(claim.quantity, 1)
  assert.deepEqual(claim.missing, [])
  const variant = variants.find((v) => v.id === claim.variantId)
  assert.deepEqual(variant?.dimensions, { warna: "hitam", size: "38" })
})

test("resolves a claim buried in a sentence", () => {
  const { dimensions, variants } = parseVariantNote(NOTE)
  const claim = resolveText("yg merah ukuran 40 dong kak", variants, dimensions)
  const variant = variants.find((v) => v.id === claim.variantId)
  assert.deepEqual(variant?.dimensions, { warna: "merah", size: "40" })
})

test("reads an explicit quantity", () => {
  const { dimensions, variants } = parseVariantNote(NOTE)
  assert.equal(resolveText("hitam 38 x2", variants, dimensions).quantity, 2)
  assert.equal(resolveText("mau 3 putih 41", variants, dimensions).quantity, 3)
})

test("a size alone reports the missing dimension rather than guessing", () => {
  const { dimensions, variants } = parseVariantNote(NOTE)
  const claim = resolveText("38", variants, dimensions)
  assert.equal(claim.variantId, null)
  assert.deepEqual(claim.missing, ["warna"])
  // The candidates are what the bot offers back: "warna apa kak?"
  assert.deepEqual(claim.candidates.sort(), ["hitam", "merah", "putih"])
})

test("text with nothing recognisable resolves to nothing", () => {
  const { dimensions, variants } = parseVariantNote(NOTE)
  const claim = resolveText("halo kak masih ada?", variants, dimensions)
  assert.equal(claim.variantId, null)
  assert.deepEqual(claim.missing.sort(), ["size", "warna"])
})

test("a quantity is never mistaken for a size", () => {
  const { dimensions, variants } = parseVariantNote(NOTE)
  // "2" is not a size in this note, so it can only be a count.
  const claim = resolveText("hitam 38 2pcs", variants, dimensions)
  assert.equal(claim.quantity, 2)
  const variant = variants.find((v) => v.id === claim.variantId)
  assert.equal(variant?.dimensions.size, "38")
})
