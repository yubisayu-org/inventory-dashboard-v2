import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyAnswer } from "./answer"

test("accepts the ordinary Indonesian yeses", () => {
  for (const text of ["ok", "oke", "boleh", "gpp", "ga papa", "mau", "iya", "yaudah", "lanjut"]) {
    assert.equal(classifyAnswer({ text }), "accept", `expected accept for "${text}"`)
  }
})

test("declines the ordinary Indonesian noes", () => {
  for (const text of ["ga jadi", "gajadi", "ga usah", "engga", "skip", "batal", "no"]) {
    assert.equal(classifyAnswer({ text }), "decline", `expected decline for "${text}"`)
  }
})

test("a negated yes is a decline, not an accept", () => {
  // "ga mau" contains "mau"; substring matching would get this backwards.
  assert.equal(classifyAnswer({ text: "ga mau" }), "decline")
  assert.equal(classifyAnswer({ text: "gak boleh" }), "decline")
})

test("reads approving and rejecting reactions", () => {
  for (const emoji of ["\u{1F44D}", "\u{1F44C}", "❤️", "✅"]) {
    assert.equal(classifyAnswer({ emoji }), "accept", `expected accept for ${emoji}`)
  }
  for (const emoji of ["\u{1F44E}", "❌"]) {
    assert.equal(classifyAnswer({ emoji }), "decline", `expected decline for ${emoji}`)
  }
})

test("an unrecognised reaction is unclear rather than assumed", () => {
  // Customers do react to the wrong message; guessing would silently corrupt a claim.
  assert.equal(classifyAnswer({ emoji: "\u{1F602}" }), "unclear")
})

test("a bare negator alone is a refusal, but inside a question it is not", () => {
  // "ga" alone answers the question. The same word inside a sentence is usually
  // asking something, and reading it as a refusal would cancel a real claim.
  assert.equal(classifyAnswer({ text: "ga" }), "decline")
  assert.equal(classifyAnswer({ text: "gak" }), "decline")
  assert.equal(classifyAnswer({ text: "muat ga ya kak?" }), "unclear")
})

test("an idiom that contains a negator still means yes", () => {
  // "ga papa" is literally "not a problem" — a customer agreeing. Every
  // negation rule would read that "ga" as a refusal, so idioms are tested first.
  assert.equal(classifyAnswer({ text: "ga papa" }), "accept")
  assert.equal(classifyAnswer({ text: "gapapa kak ambil aja" }), "accept")
})

test("anything unrecognisable is unclear", () => {
  assert.equal(classifyAnswer({ text: "kalau 95 muat ga ya?" }), "unclear")
  assert.equal(classifyAnswer({}), "unclear")
})
