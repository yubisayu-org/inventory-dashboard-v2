import { test } from "node:test"
import assert from "node:assert/strict"
import { marksFor } from "../hooks/useHitAndRun"

const MARKS = new Map<string, string[]>([
  ["rinaaa", ["HIT & RUN POCN202603 Rp 954.000", "HIT & RUN LSKR202603 Rp 1.690.000"]],
  ["rindaaa", ["HIT & RUN LSJP202601 Rp 300.000"]],
  ["hanihani", ["HIT & RUN LSKR202507 Rp 120.000"]],
])

test("a full handle is matched exactly", () => {
  const m = marksFor(MARKS, "rinaaa")
  assert.equal(m.length, 1)
  assert.equal(m[0].exact, true)
  assert.equal(m[0].stamps.length, 2)
})

test("the @ and the casing do not matter", () => {
  assert.equal(marksFor(MARKS, "@RinAaa")[0]?.exact, true)
})

test("a part-typed handle finds the candidates, marked as not yet her", () => {
  // The list marks these options as you scroll them. The banner ignores them:
  // "rin" is not a person yet, and a warning about somebody who has not been
  // chosen is the kind that gets learned away.
  const m = marksFor(MARKS, "rin")
  assert.equal(m.length, 2, "both rinaaa and rindaaa are still possible")
  assert.ok(m.every((x) => !x.exact))
})

test("an exact hit does not also drag in the people it prefixes", () => {
  const m = marksFor(MARKS, "rinaaa")
  assert.deepEqual(m.map((x) => x.who), ["rinaaa"])
})

test("one or two characters cry wolf, so they say nothing", () => {
  assert.deepEqual(marksFor(MARKS, "r"), [])
  assert.deepEqual(marksFor(MARKS, "ri"), [])
  assert.deepEqual(marksFor(MARKS, ""), [])
})

test("somebody unmarked is not flagged by a prefix of somebody who is", () => {
  assert.deepEqual(marksFor(MARKS, "citra"), [])
})
