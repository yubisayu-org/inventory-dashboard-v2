import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyOwnerReaction, outcomeFor } from "./outcomes"

test("the owner's tick means bought and their cross means not", () => {
  assert.equal(classifyOwnerReaction("✅"), "bought")
  assert.equal(classifyOwnerReaction("☑️"), "bought")
  assert.equal(classifyOwnerReaction("❌"), "missed")
  assert.equal(classifyOwnerReaction("✖️"), "missed")
})

test("the bot's own capture vocabulary is not an instruction", () => {
  // 📝 and ❔ are what the BOT puts on a claim. Reading them back as the owner
  // saying something would make the bot answer itself.
  assert.equal(classifyOwnerReaction("📝"), null)
  assert.equal(classifyOwnerReaction("❔"), null)
  assert.equal(classifyOwnerReaction("😢"), null)
})

test("an unrelated reaction means nothing", () => {
  assert.equal(classifyOwnerReaction("😂"), null)
  assert.equal(classifyOwnerReaction(""), null)
})

test("a claim's outcome follows what it obtained", () => {
  assert.equal(outcomeFor({ quantity: 1, obtained: 1, state: "assigned" }), "✅")
  assert.equal(outcomeFor({ quantity: 2, obtained: 2, state: "assigned" }), "✅")
  assert.equal(
    outcomeFor({ quantity: 2, obtained: 1, state: "assigned" }),
    "✅",
    "partly filled still means something is theirs",
  )
  assert.equal(
    outcomeFor({ quantity: 1, obtained: 0, state: "assigned" }),
    null,
    "nothing bought yet is not the same as missing out",
  )
})

test("a rejected claim is a cross, whatever it obtained", () => {
  assert.equal(outcomeFor({ quantity: 1, obtained: 0, state: "rejected" }), "❌")
})
