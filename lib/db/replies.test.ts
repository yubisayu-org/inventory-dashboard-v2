import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "@/lib/db-pool"
import { queueReaction, queueText, nextPendingReply, markReplySent, markReplyFailed } from "./replies"

const GROUP = `${process.hrtime.bigint()}@g.us`
const HER = "628111111111@s.whatsapp.net"

after(async () => {
  await sql`DELETE FROM wa_replies WHERE group_jid = ${GROUP}`
  await sql.end()
})

test("queueReaction and nextPendingReply round-trip a reaction row, including the participant", async () => {
  await queueReaction(GROUP, "msg-1", "✅", HER)
  const item = await nextPendingReply()
  assert.equal(item?.groupJid, GROUP)
  assert.equal(item?.quotedMessageId, "msg-1")
  assert.equal(item?.reaction, "✅")
  assert.equal(item?.text, "")
  assert.equal(item?.participant, HER, "the customer's own number, for a correctly-quoting synthetic key")
  await markReplySent(item!.id)
})

test("queueText and nextPendingReply round-trip a text row, including the participant", async () => {
  await queueText(GROUP, "msg-2", "Sudah dicatat ya kak — K42 ×1 ✅", HER)
  const item = await nextPendingReply()
  assert.equal(item?.text, "Sudah dicatat ya kak — K42 ×1 ✅")
  assert.equal(item?.reaction, "")
  assert.equal(item?.participant, HER)
  await markReplySent(item!.id)
})

test("nextPendingReply returns oldest-first", async () => {
  await queueText(GROUP, "msg-3", "first", HER)
  await queueText(GROUP, "msg-4", "second", HER)
  const first = await nextPendingReply()
  assert.equal(first?.text, "first")
  await markReplySent(first!.id)
  const second = await nextPendingReply()
  assert.equal(second?.text, "second")
  await markReplySent(second!.id)
})

test("markReplyFailed leaves the row out of the pending queue", async () => {
  await queueText(GROUP, "msg-5", "will fail", HER)
  const item = await nextPendingReply()
  await markReplyFailed(item!.id, "network")
  const next = await nextPendingReply()
  assert.equal(next, null)
  const [row] = await sql`SELECT state, error FROM wa_replies WHERE id = ${item!.id}`
  assert.equal(row.state, "failed")
  assert.equal(row.error, "network")
})
