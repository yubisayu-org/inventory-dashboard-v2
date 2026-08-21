import { test } from "node:test"
import assert from "node:assert/strict"
import { CODE_LETTERS, nextCode, parseCodes } from "./codes"

test("the alphabet excludes I, O, S and includes Q", () => {
  assert.equal(CODE_LETTERS.includes("I"), false)
  assert.equal(CODE_LETTERS.includes("O"), false)
  assert.equal(CODE_LETTERS.includes("S"), false)
  assert.equal(CODE_LETTERS.includes("Q"), true)
  assert.equal(CODE_LETTERS.length, 23)
})

test("nextCode starts a fresh event at A01", () => {
  assert.equal(nextCode([]), "A01")
})

test("nextCode continues the highest issued code", () => {
  assert.equal(nextCode(["A01", "A02"]), "A03")
})

test("nextCode does not backfill a gap left by a middle removal", () => {
  // K41, K42, K43 issued; K42 removed. Next is K44, not K42.
  assert.equal(nextCode(["A41", "A43"]), "A44")
})

test("A99 rolls to B01", () => {
  assert.equal(nextCode(["A99"]), "B01")
})

test("nextCode throws once the alphabet is exhausted", () => {
  assert.throws(() => nextCode(["Z99"]), /exhausted/)
})

test("parseCodes finds a code in ordinary claim text", () => {
  assert.deepEqual(parseCodes("K42 mau 1"), ["K42"])
  assert.deepEqual(parseCodes("mau K41 dua ya kak"), ["K41"])
})

test("parseCodes rejects a bare number and a size-like token", () => {
  assert.deepEqual(parseCodes("100 aja kak"), [])
  assert.deepEqual(parseCodes("ukuran 38L ya"), [])
})

test("parseCodes rejects a letter outside the alphabet", () => {
  assert.deepEqual(parseCodes("I42 mau 1"), [])
  assert.deepEqual(parseCodes("O10 mau 1"), [])
})

test("parseCodes finds every distinct code in a multi-code message", () => {
  assert.deepEqual(parseCodes("K41 sama K42 masing-masing 1"), ["K41", "K42"])
})

test("parseCodes is case-insensitive and normalizes to uppercase", () => {
  assert.deepEqual(parseCodes("k42 mau 1"), ["K42"])
})
