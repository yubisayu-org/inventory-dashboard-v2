import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "@/lib/db-pool"
import { queueReaction, queueText, nextPendingReply, markReplySent, markReplyFailed } from "./replies"

// A group nobody else uses, and every read below is scoped to it. Test files
// run in parallel against one database, and nextPendingReply is otherwise
// global — without the scope, this file can be handed another file's row.
const GROUP = `${process.hrtime.bigint()}@g.us`
const HER = "628111111111@s.whatsapp.net"

after(async () => {
  await sql`DELETE FROM wa_replies WHERE group_jid = ${GROUP}`
  await sql.end()
})

test("queueReaction and nextPendingReply round-trip a reaction row, including the participant", async () => {
  await queueReaction(GROUP, "msg-1", "✅", HER)
  const item = await nextPendingReply(sql, GROUP)
  assert.equal(item?.groupJid, GROUP)
  assert.equal(item?.quotedMessageId, "msg-1")
  assert.equal(item?.reaction, "✅")
  assert.equal(item?.text, "")
  assert.equal(item?.participant, HER, "the customer's own number, for a correctly-quoting synthetic key")
  await markReplySent(item!.id)
})

test("queueText and nextPendingReply round-trip a text row, including the participant", async () => {
  await queueText(GROUP, "msg-2", "Sudah dicatat ya kak — K42 ×1 ✅", HER)
  const item = await nextPendingReply(sql, GROUP)
  assert.equal(item?.text, "Sudah dicatat ya kak — K42 ×1 ✅")
  assert.equal(item?.reaction, "")
  assert.equal(item?.participant, HER)
  await markReplySent(item!.id)
})

test("nextPendingReply returns oldest-first", async () => {
  await queueText(GROUP, "msg-3", "first", HER)
  await queueText(GROUP, "msg-4", "second", HER)
  const first = await nextPendingReply(sql, GROUP)
  assert.equal(first?.text, "first")
  await markReplySent(first!.id)
  const second = await nextPendingReply(sql, GROUP)
  assert.equal(second?.text, "second")
  await markReplySent(second!.id)
})

test("two overlapping claims never return the same reply row (finding #11 — atomic claim via SKIP LOCKED)", async () => {
  await queueText(GROUP, "msg-6", "one", HER)
  await queueText(GROUP, "msg-7", "two", HER)

  const [a, b] = await Promise.all([nextPendingReply(sql, GROUP), nextPendingReply(sql, GROUP)])
  assert.ok(a && b, "both queued rows must be claimed")
  assert.notEqual(a!.id, b!.id, "two concurrent claims must never return the same row")
  assert.deepEqual([a!.text, b!.text].sort(), ["one", "two"])

  await markReplySent(a!.id)
  await markReplySent(b!.id)
})

test("markReplyFailed leaves the row out of the pending queue", async () => {
  await queueText(GROUP, "msg-5", "will fail", HER)
  const item = await nextPendingReply(sql, GROUP)
  await markReplyFailed(item!.id, "network")
  const next = await nextPendingReply(sql, GROUP)
  assert.equal(next, null)
  const [row] = await sql`SELECT state, error FROM wa_replies WHERE id = ${item!.id}`
  assert.equal(row.state, "failed")
  assert.equal(row.error, "network")
})
