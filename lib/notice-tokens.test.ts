import { test } from "node:test"
import assert from "node:assert/strict"
import { NOTICE_TEMPLATES, NOTICE_TOKENS_FOR, unknownTokens, fillNotice } from "./notice-templates"

/*
 * The guard that was missing.
 *
 * Five plan-change notices shipped with {by} and {partners} in their wording
 * and neither token registered. fillNotice leaves an unknown token exactly as
 * written, sendInvoiceNotice refuses any text containing one, and the caller
 * swallowed the refusal — so every plan change went unannounced and nothing
 * said why. A customer held an order three times and heard nothing, twice.
 *
 * These need no database, which is the point: the tests that would have caught
 * it needed one, and could not be run.
 */
test("every template is made only of tokens we know", () => {
  for (const t of NOTICE_TEMPLATES) {
    assert.deepEqual(
      unknownTokens(`${t.title} ${t.body}`),
      [],
      `${t.key} uses a placeholder sendInvoiceNotice will refuse`,
    )
  }
})

test("every template resolves to text with no placeholder left in it", () => {
  // Filled the way a caller fills it: every token the template names, present.
  for (const t of NOTICE_TEMPLATES) {
    const values = Object.fromEntries(
      (NOTICE_TOKENS_FOR[t.key] ?? []).map((token) => [token, "x"]),
    )
    const out = `${fillNotice(t.title, values)} ${fillNotice(t.body, values)}`
    assert.doesNotMatch(out, /\{[a-zA-Z]+\}/, `${t.key} leaves a hole she would read`)
  }
})

// The guidance map and the wording have to agree, or the settings screen
// promises a placeholder that fills with nothing.
test("what a template says it accepts is what it actually uses", () => {
  for (const t of NOTICE_TEMPLATES) {
    if (t.key === "inbox_custom") continue
    const used = new Set(`${t.title} ${t.body}`.match(/\{[a-zA-Z]+\}/g) ?? [])
    const declared = new Set(NOTICE_TOKENS_FOR[t.key] ?? [])
    for (const token of used) {
      assert.ok(declared.has(token), `${t.key} uses ${token} without declaring it`)
    }
  }
})
