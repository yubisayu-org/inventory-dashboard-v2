import { test } from "node:test"
import assert from "node:assert/strict"
import {
  NOTICE_KEYS,
  NOTICE_TEMPLATES,
  NOTICE_TOKENS,
  NOTICE_TOKENS_FOR,
  applyNoticeOverrides,
  unknownTokens,
} from "./notice-templates"

// The owner's edits laid over the house wording. The rule that matters is
// which way a blank falls: towards ours, never towards an empty notice.

test("no overrides at all leaves the house wording untouched", () => {
  assert.equal(applyNoticeOverrides(null), NOTICE_TEMPLATES)
  assert.equal(applyNoticeOverrides(undefined), NOTICE_TEMPLATES)
  const same = applyNoticeOverrides({})
  assert.deepEqual(same, NOTICE_TEMPLATES)
})

test("an edit replaces only the field it filled", () => {
  const out = applyNoticeOverrides({
    inbox_delayed: { title: "Late, sorry", body: "" },
  })
  const delayed = out.find((t) => t.key === "inbox_delayed")!
  const house = NOTICE_TEMPLATES.find((t) => t.key === "inbox_delayed")!
  assert.equal(delayed.title, "Late, sorry")
  assert.equal(delayed.body, house.body)
  // Everything else is left exactly as shipped.
  assert.deepEqual(
    out.filter((t) => t.key !== "inbox_delayed"),
    NOTICE_TEMPLATES.filter((t) => t.key !== "inbox_delayed"),
  )
})

test("whitespace is a blank, not an edit — it would send a notice with no title", () => {
  const out = applyNoticeOverrides({ inbox_delayed: { title: "   ", body: "\n\n" } })
  const delayed = out.find((t) => t.key === "inbox_delayed")!
  const house = NOTICE_TEMPLATES.find((t) => t.key === "inbox_delayed")!
  assert.equal(delayed.title, house.title)
  assert.equal(delayed.body, house.body)
})

test("a row for a template we no longer ship is ignored, not resurrected", () => {
  const out = applyNoticeOverrides({
    inbox_retired: { title: "Gone", body: "Gone" },
  } as any)
  assert.equal(out.length, NOTICE_TEMPLATES.length)
  assert.ok(!out.some((t) => t.title === "Gone"))
})

test("an override never turns isRefund on or off", () => {
  const out = applyNoticeOverrides({
    inbox_refund_offered: { title: "Money back", body: "Some money." },
    inbox_delayed: { title: "Late", body: "Sorry." },
  })
  assert.equal(out.find((t) => t.key === "inbox_refund_offered")!.isRefund, true)
  assert.ok(!out.find((t) => t.key === "inbox_delayed")!.isRefund)
})

// ── the token guidance the settings screen shows ────────────────

test("every shipped template has a token list, and every listed token is real", () => {
  assert.deepEqual(NOTICE_KEYS, NOTICE_TEMPLATES.map((t) => t.key))
  for (const key of NOTICE_KEYS) {
    const listed = NOTICE_TOKENS_FOR[key]
    assert.ok(listed, `${key} has no token list`)
    for (const token of listed) {
      assert.ok(
        (NOTICE_TOKENS as readonly string[]).includes(token),
        `${key} lists ${token}, which fillNotice does not know`,
      )
    }
  }
})

test("the house wording only uses tokens its own list promises", () => {
  for (const t of NOTICE_TEMPLATES) {
    assert.deepEqual(unknownTokens(`${t.title} ${t.body}`), [])
    const used = `${t.title} ${t.body}`.match(/\{[a-zA-Z]+\}/g) ?? []
    for (const token of new Set(used)) {
      assert.ok(
        NOTICE_TOKENS_FOR[t.key].includes(token),
        `${t.key} uses ${token}, which is not in its own list`,
      )
    }
  }
})
