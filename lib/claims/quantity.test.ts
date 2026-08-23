import { test } from "node:test"
import assert from "node:assert/strict"
import { parseQuantity, hasOrderingIntent } from "./quantity"

test("silence means one", () => {
  assert.equal(parseQuantity(""), 1)
  assert.equal(parseQuantity("yang beruang ya kak"), 1)
  assert.equal(parseQuantity("size 90"), 1)
})

test("a number with a unit is a count", () => {
  assert.equal(parseQuantity("2 pcs ya kak"), 2)
  assert.equal(parseQuantity("size 90, 3 set"), 3)
  assert.equal(parseQuantity("4 pasang"), 4)
})

test("a verb of wanting makes the number beside it a count", () => {
  assert.equal(parseQuantity("size 90 mau 3 yah"), 3)
  assert.equal(parseQuantity("ambil 2 ya"), 2)
  assert.equal(parseQuantity("minta 5 kak"), 5)
})

test("an each-phrase counts too", () => {
  assert.equal(parseQuantity("masing-masing 4"), 4)
  assert.equal(parseQuantity("masing2 2 ya kak"), 2)
  assert.equal(parseQuantity("per item 3"), 3)
})

test("the shorthands people actually type", () => {
  assert.equal(parseQuantity("x3"), 3)
  assert.equal(parseQuantity("@2 size 95"), 2)
  assert.equal(parseQuantity("size 95 2x"), 2)
})

test("a size is never read as a quantity", () => {
  // The catalogue is sized 50 to 160 and captions are mostly about size, so a
  // cue next to a size-shaped number must not turn into ninety units.
  assert.equal(parseQuantity("mau 90"), 1)
  assert.equal(parseQuantity("ambil size 100 ya"), 1)
  assert.equal(parseQuantity("uk 125"), 1)
  // Unless it says the unit outright, which nobody types about a size.
  assert.equal(parseQuantity("100 pcs"), 1, "and past the sane ceiling it is ignored")
})

test("an absurd number is ignored rather than ordered", () => {
  assert.equal(parseQuantity("mau 500"), 1)
  assert.equal(parseQuantity("30 pcs"), 1, "past the ceiling this is not a jastip order")
})

test("two claims in one caption take the larger", () => {
  // Both say "more than one", and arriving one over is cheaper than arriving
  // short.
  assert.equal(parseQuantity("mau 2, masing-masing 3"), 3)
})

test("hasOrderingIntent: a bare ordering verb is intent, even with no number beside it", () => {
  assert.equal(hasOrderingIntent("mau dong A11"), true)
  assert.equal(hasOrderingIntent("minta yang itu"), true)
})

test("hasOrderingIntent: a unit or shorthand is intent", () => {
  assert.equal(hasOrderingIntent("2 pcs"), true)
  assert.equal(hasOrderingIntent("A11 x3"), true)
  assert.equal(hasOrderingIntent("masing-masing 2"), true)
})

test("hasOrderingIntent: naming a code or a size alone is not intent", () => {
  assert.equal(hasOrderingIntent("A11"), false)
  assert.equal(hasOrderingIntent("ada ukuran apa aja?"), false)
  assert.equal(hasOrderingIntent("size 90"), false)
})
