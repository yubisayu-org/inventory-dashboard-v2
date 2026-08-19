import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "@/lib/db-pool"
import { createSend, attachProductToSend } from "./wa-sends"
import {
  createDirectClaim, createAskingRequest, createRejectedClaim,
  resolveAskingCandidate, findRequestByBotMessage,
} from "./catalogue-requests"

const EVENT = `TESTWACR${process.hrtime.bigint()}`
let postId: number
let productId: number
let sendId: number
let sendCodeId: number

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  const [post] = await sql`INSERT INTO catalogue_posts (media_url, media_type) VALUES ('https://example.com/t.jpg', 'photo') RETURNING id`
  postId = post.id as number
  const [product] = await sql`INSERT INTO products (name, store, price) VALUES ('Test Product', 'ZHG', 100000) RETURNING id`
  productId = product.id as number
  const send = await createSend({ postId, event: EVENT, title: "t" })
  sendId = send.id
  const code = await attachProductToSend(sendId, productId)
  sendCodeId = code.id
})

after(async () => {
  await sql`DELETE FROM catalogue_requests WHERE send_id = ${sendId}`
  await sql`DELETE FROM wa_send_codes WHERE send_id = ${sendId}`
  await sql`DELETE FROM wa_sends WHERE id = ${sendId}`
  await sql`DELETE FROM catalogue_post_products WHERE post_id = ${postId}`
  await sql`DELETE FROM catalogue_posts WHERE id = ${postId}`
  await sql`DELETE FROM products WHERE id = ${productId}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

test("createDirectClaim writes a pending, whatsapp-sourced row", async () => {
  const { id } = await createDirectClaim({
    customerHandle: "628111111111", productId, qty: 1, note: "K42 mau 1",
    sendId, sendCodeId, sender: "628111111111", messageId: "her-1",
  })
  const [row] = await sql`SELECT * FROM catalogue_requests WHERE id = ${id}`
  assert.equal(row.source, "whatsapp")
  assert.equal(row.status, "pending")
  assert.equal(row.product_id, productId)
  assert.equal(row.send_code_id, sendCodeId)
})

test("createAskingRequest writes a null-product asking row with candidates", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628122222222", qty: 1, note: "yang hitam mau 1",
    sendId, sender: "628122222222", messageId: "her-2", botMessageId: "bot-1",
    candidateSendCodeIds: [sendCodeId],
  })
  const [row] = await sql`SELECT * FROM catalogue_requests WHERE id = ${id}`
  assert.equal(row.status, "asking")
  assert.equal(row.product_id, null)
  assert.deepEqual(row.candidate_send_code_ids, [sendCodeId])
})

test("resolveAskingCandidate (customer side) moves the row to pending without queueing a reply", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628133333333", qty: 1, note: "t",
    sendId, sender: "628133333333", messageId: "her-3", botMessageId: "bot-2",
    candidateSendCodeIds: [sendCodeId],
  })
  await resolveAskingCandidate(id, sendCodeId, "customer")
  const [row] = await sql`SELECT status, product_id, send_code_id FROM catalogue_requests WHERE id = ${id}`
  assert.equal(row.status, "pending")
  assert.equal(row.product_id, productId)
  assert.equal(row.send_code_id, sendCodeId)

  const [{ count }] = await sql`SELECT count(*)::int FROM wa_replies WHERE quoted_message_id = 'her-3'`
  assert.equal(count, 0, "the customer resolving her own offer needs no queued reply")
})

test("resolveAskingCandidate (owner side) queues the closing text quoting her message", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628144444444", qty: 1, note: "t",
    sendId, sender: "628144444444", messageId: "her-4", botMessageId: "bot-3",
    candidateSendCodeIds: [sendCodeId],
  })
  await resolveAskingCandidate(id, sendCodeId, "owner")
  const [row] = await sql`SELECT status FROM catalogue_requests WHERE id = ${id}`
  assert.equal(row.status, "pending")

  const [reply] = await sql`SELECT text, quoted_message_id, group_jid FROM wa_replies WHERE quoted_message_id = 'her-4'`
  assert.ok(reply, "owner resolution must queue a reply since the dashboard has no socket")
  assert.ok(reply.text.includes("Sudah dicatat"))
})

test("resolveAskingCandidate is idempotent — a second call on an already-resolved row does nothing", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628155555555", qty: 1, note: "t",
    sendId, sender: "628155555555", messageId: "her-5", botMessageId: "bot-4",
    candidateSendCodeIds: [sendCodeId],
  })
  await resolveAskingCandidate(id, sendCodeId, "customer")
  await resolveAskingCandidate(id, sendCodeId, "owner")
  const [{ count }] = await sql`SELECT count(*)::int FROM wa_replies WHERE quoted_message_id = 'her-5'`
  assert.equal(count, 0, "second resolution must be a no-op, including no duplicate queued reply")
})

test("findRequestByBotMessage resolves an open asking row by the bot's own message id", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628166666666", qty: 1, note: "t",
    sendId, sender: "628166666666", messageId: "her-6", botMessageId: "bot-6",
    candidateSendCodeIds: [sendCodeId],
  })
  const found = await findRequestByBotMessage("bot-6")
  assert.equal(found?.id, id)
  assert.equal(found?.sendId, sendId)
  assert.deepEqual(found?.candidateSendCodeIds, [sendCodeId])
})

test("findRequestByBotMessage returns null once the row has resolved", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628177777777", qty: 1, note: "t",
    sendId, sender: "628177777777", messageId: "her-7", botMessageId: "bot-7",
    candidateSendCodeIds: [sendCodeId],
  })
  await resolveAskingCandidate(id, sendCodeId, "customer")
  const found = await findRequestByBotMessage("bot-7")
  assert.equal(found, null, "a 👍 arriving after resolution must find nothing to act on")
})

test("createRejectedClaim writes a rejected, whatsapp-sourced row with no product", async () => {
  const { id } = await createRejectedClaim({
    customerHandle: "628188888888", qty: 1, note: "A21 mau 1",
    sendId, sender: "628188888888", messageId: "her-8",
  })
  const [row] = await sql`SELECT status, product_id, staff_note FROM catalogue_requests WHERE id = ${id}`
  assert.equal(row.status, "rejected")
  assert.equal(row.product_id, null)
  assert.equal(row.staff_note, "trip sudah tutup")
})
