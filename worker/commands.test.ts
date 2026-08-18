import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCommand } from "./commands"

test("opening a capture window carries the store", () => {
  assert.deepEqual(parseCommand("/mulai Nishimatsuya"), {
    kind: "open",
    store: "Nishimatsuya",
  })
  assert.deepEqual(parseCommand("/mulai Akachan Honpo Umeda"), {
    kind: "open",
    store: "Akachan Honpo Umeda",
  })
})

test("a window can be opened without naming a store", () => {
  // The owner can add it in the dashboard later; refusing here would mean
  // standing in a shop arguing with a bot.
  assert.deepEqual(parseCommand("/mulai"), { kind: "open", store: "" })
})

test("the other commands take no argument", () => {
  assert.deepEqual(parseCommand("/selesai"), { kind: "close" })
  assert.deepEqual(parseCommand("/rekap"), { kind: "rekap" })
  assert.deepEqual(parseCommand("/connect"), { kind: "connect" })
})

test("case and stray whitespace do not stop a command working", () => {
  assert.deepEqual(parseCommand("  /REKAP  "), { kind: "rekap" })
  assert.deepEqual(parseCommand("/Mulai   Loft  "), { kind: "open", store: "Loft" })
})

test("ordinary chat is not a command", () => {
  assert.equal(parseCommand("mau yg 95 ya kak"), null)
  assert.equal(parseCommand(""), null)
  assert.equal(parseCommand("rekap dong kak"), null, "a command must start with a slash")
})

test("an unknown slash word is not a command", () => {
  // Silence, not an error: the group is full of humans, and a bot correcting
  // their typing is noise nobody asked for.
  assert.equal(parseCommand("/tutup"), null)
  assert.equal(parseCommand("/help"), null)
})

test("a command must be the whole first word, not part of one", () => {
  assert.equal(parseCommand("/rekapitulasi"), null)
})

test("/katalog asks for the trip's link", () => {
  assert.deepEqual(parseCommand("/katalog"), { kind: "katalog" })
  assert.deepEqual(parseCommand("  /KATALOG  "), { kind: "katalog" })
  assert.equal(parseCommand("katalog dong kak"), null, "a word in chatter is not a command")
})
