import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getNoticeTemplates, updateNoticeTemplate } from "./settings"
import { applyNoticeOverrides, NOTICE_TEMPLATES } from "../notice-templates"

// The owner's edits, stored. What is worth testing here is not the upsert but
// what the read does with a row that is blank, foreign, or absent — those are
// the shapes that decide whether a customer gets a notice or a hole.

after(async () => {
  await sql`DELETE FROM notice_templates WHERE key IN ('inbox_delayed', 'inbox_custom')`
  await sql.end()
})

test("an edit survives the round trip and lands on the right key", async () => {
  await updateNoticeTemplate("inbox_delayed", {
    title: "{event} berangkat lebih lambat",
    body: "Trip mundur sedikit. Tanggal baru menyusul di sini.",
  })
  const stored = await getNoticeTemplates()
  assert.equal(stored.inbox_delayed?.title, "{event} berangkat lebih lambat")
  assert.match(stored.inbox_delayed?.body ?? "", /Tanggal baru/)

  const merged = applyNoticeOverrides(stored)
  const delayed = merged.find((t) => t.key === "inbox_delayed")!
  assert.equal(delayed.title, "{event} berangkat lebih lambat")
  // Nothing else moved.
  const invoice = merged.find((t) => t.key === "inbox_invoice_due")!
  assert.equal(invoice.body, NOTICE_TEMPLATES.find((t) => t.key === "inbox_invoice_due")!.body)
})

test("a stored blank reads back as a blank and merges to the house wording", async () => {
  await updateNoticeTemplate("inbox_custom", { title: "", body: "" })
  const stored = await getNoticeTemplates()
  assert.deepEqual(stored.inbox_custom, { title: "", body: "" })

  const merged = applyNoticeOverrides(stored)
  const custom = merged.find((t) => t.key === "inbox_custom")!
  const house = NOTICE_TEMPLATES.find((t) => t.key === "inbox_custom")!
  assert.equal(custom.title, house.title)
  assert.equal(custom.body, house.body)
})

test("a key we do not ship is dropped on the way out of the database", async () => {
  await sql`
    INSERT INTO notice_templates (key, title, body)
    VALUES ('inbox_retired', 'Gone', 'Gone')
    ON CONFLICT (key) DO UPDATE SET title = 'Gone', body = 'Gone'`
  try {
    const stored = await getNoticeTemplates()
    assert.ok(!("inbox_retired" in stored))
  } finally {
    await sql`DELETE FROM notice_templates WHERE key = 'inbox_retired'`
  }
})
