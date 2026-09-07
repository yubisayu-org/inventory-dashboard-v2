import { test } from "node:test"
import assert from "node:assert/strict"
import {
  NOTICE_KEYS,
  NOTICE_TEMPLATES,
  NOTICE_TOKENS,
  NOTICE_TOKENS_FOR,
  applyNoticeOverrides,
  unknownTokens,
  replyLeadFor,
  REFUND_CAUSES,
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

// A wrong delivery is the one refund she can decline: the parcel exists and is
// hers if she wants it. That choice used to sit in the cause paragraph, above
// the amount and eight lines above the boxes to fill in — so the message asked
// her to choose, talked about money, then asked for an account number as though
// she had already chosen.
test("the offer to keep what came sits with the question it answers", () => {
  const lead = replyLeadFor(["wrong_item"])
  assert.match(lead, /^Jika Anda ingin tetap mengambil barang yang datang/)
  assert.match(lead, /mohon balas pesan ini dengan informasi berikut:$/)

  // The cause itself no longer makes the offer, so it is made once.
  const cause = REFUND_CAUSES.find((c) => c.key === "wrong_item")!
  assert.doesNotMatch(cause.waLine ?? "", /tetap mengambil/)
  // And it lost the dash it used for a comma.
  assert.doesNotMatch(cause.waLine ?? "", /—/)
})

test("a refund with nothing to keep asks plainly", () => {
  assert.equal(replyLeadFor(["unavailable"]), "Mohon balas pesan ini dengan informasi berikut:")
  assert.equal(replyLeadFor([]), "Mohon balas pesan ini dengan informasi berikut:")
  // A group of several refunds only offers it when every one of them can be
  // declined — otherwise it offers to keep something that does not exist.
  assert.equal(
    replyLeadFor(["wrong_item", "unavailable"]),
    "Mohon balas pesan ini dengan informasi berikut:",
  )
  assert.match(replyLeadFor(["wrong_item", "wrong_item"]), /tetap mengambil/)
})
