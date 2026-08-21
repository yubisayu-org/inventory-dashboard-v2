import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "@/lib/db-pool"
import { createSend, attachProductToSend } from "./wa-sends"
import {
  createDirectClaim, createAskingRequest, createRejectedClaim,
  resolveAskingCandidate, findRequestByBotMessage,
  createCatalogueRequest, convertCatalogueRequest, rejectCatalogueRequest,
  getCatalogueRequests,
} from "./catalogue-requests"

// Message ids are literals like "her-1", and four test files use the same ones
// against one database while running in parallel — so a row this file inserts
// can be read back as another file's. TAG makes them unique per file per run;
// id() is how every id in this file is written.
const TAG = `${process.hrtime.bigint()}-`
const id = (s: string) => TAG + s

const EVENT = `TESTWACR${process.hrtime.bigint()}`
let postId: number
let productId: number
let productBId: number
let sendId: number
let sendCodeId: number
// Customer handles created ad hoc by a test below (for the "resolved
// identity" guard) — deleted in after(), AFTER orders are deleted, since an
// order row FK-references its customer.
const extraCustomers: string[] = []

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
  const [productB] = await sql`INSERT INTO products (name, store, price) VALUES ('Test Product B', 'ZHG', 150000) RETURNING id`
  productBId = productB.id as number
  const send = await createSend({ postId, event: EVENT, title: "t" })
  sendId = send.id
  const code = await attachProductToSend(sendId, productId)
  sendCodeId = code.id
})

after(async () => {
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  if (extraCustomers.length > 0) await sql`DELETE FROM customers WHERE instagram_id IN ${sql(extraCustomers)}`
  await sql`DELETE FROM catalogue_requests WHERE send_id = ${sendId}`
  await sql`DELETE FROM catalogue_requests WHERE customer_handle = 'web_user'`
  // her-4/her-8/her-9 are queued by the pre-existing resolveAskingCandidate
  // (owner)/reject tests above, and her-t5 by the new "Tolak a zero-
  // candidate asking row" test (rejectCatalogueRequest queues a ❌ for any
  // whatsapp-sourced row with a message_id, asking rows included) — cleaned
  // up here too so a repeat `npm test` run doesn't leave a pending row
  // behind for another test FILE's un-scoped nextPendingReply() (lib/db/
  // replies.test.ts) to pick up instead of its own freshly-queued one.
  await sql`DELETE FROM wa_replies WHERE quoted_message_id IN (${id("her-4")}, ${id("her-8")}, ${id("her-9")}, ${id("her-t5")})`
  await sql`DELETE FROM wa_send_codes WHERE send_id = ${sendId}`
  await sql`DELETE FROM wa_sends WHERE id = ${sendId}`
  await sql`DELETE FROM catalogue_post_products WHERE post_id = ${postId}`
  await sql`DELETE FROM catalogue_posts WHERE id = ${postId}`
  await sql`DELETE FROM products WHERE id = ${productId}`
  await sql`DELETE FROM products WHERE id = ${productBId}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

test("createDirectClaim writes a pending, whatsapp-sourced row", async () => {
  const { id } = await createDirectClaim({
    customerHandle: "628111111111", productId, qty: 1, note: "K42 mau 1",
    sendId, sendCodeId, sender: "628111111111", messageId: id("her-1"),
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
    sendId, sender: "628122222222", messageId: id("her-2"), botMessageId: "bot-1",
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
    sendId, sender: "628133333333", messageId: id("her-3"), botMessageId: "bot-2",
    candidateSendCodeIds: [sendCodeId],
  })
  await resolveAskingCandidate(id, sendCodeId, "customer")
  const [row] = await sql`SELECT status, product_id, send_code_id FROM catalogue_requests WHERE id = ${id}`
  assert.equal(row.status, "pending")
  assert.equal(row.product_id, productId)
  assert.equal(row.send_code_id, sendCodeId)

  const [{ count }] = await sql`SELECT count(*)::int FROM wa_replies WHERE quoted_message_id = ${id("her-3")}`
  assert.equal(count, 0, "the customer resolving her own offer needs no queued reply")
})

test("resolveAskingCandidate (owner side) queues the closing text quoting her message", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628144444444", qty: 1, note: "t",
    sendId, sender: "628144444444", messageId: id("her-4"), botMessageId: "bot-3",
    candidateSendCodeIds: [sendCodeId],
  })
  await resolveAskingCandidate(id, sendCodeId, "owner")
  const [row] = await sql`SELECT status FROM catalogue_requests WHERE id = ${id}`
  assert.equal(row.status, "pending")

  const [reply] = await sql`SELECT text, quoted_message_id, group_jid FROM wa_replies WHERE quoted_message_id = ${id("her-4")}`
  assert.ok(reply, "owner resolution must queue a reply since the dashboard has no socket")
  assert.ok(reply.text.includes("Sudah dicatat"))
})

test("resolveAskingCandidate is idempotent — a second call on an already-resolved row does nothing", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628155555555", qty: 1, note: "t",
    sendId, sender: "628155555555", messageId: id("her-5"), botMessageId: "bot-4",
    candidateSendCodeIds: [sendCodeId],
  })
  await resolveAskingCandidate(id, sendCodeId, "customer")
  await resolveAskingCandidate(id, sendCodeId, "owner")
  const [{ count }] = await sql`SELECT count(*)::int FROM wa_replies WHERE quoted_message_id = ${id("her-5")}`
  assert.equal(count, 0, "second resolution must be a no-op, including no duplicate queued reply")
})

test("findRequestByBotMessage resolves an open asking row by the bot's own message id", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628166666666", qty: 1, note: "t",
    sendId, sender: "628166666666", messageId: id("her-6"), botMessageId: "bot-6",
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
    sendId, sender: "628177777777", messageId: id("her-7"), botMessageId: "bot-7",
    candidateSendCodeIds: [sendCodeId],
  })
  await resolveAskingCandidate(id, sendCodeId, "customer")
  const found = await findRequestByBotMessage("bot-7")
  assert.equal(found, null, "a 👍 arriving after resolution must find nothing to act on")
})

test("createRejectedClaim writes a rejected, whatsapp-sourced row with no product", async () => {
  const { id } = await createRejectedClaim({
    customerHandle: "628188888888", qty: 1, note: "A21 mau 1",
    sendId, sender: "628188888888", messageId: id("her-8"),
  })
  const [row] = await sql`SELECT status, product_id, staff_note FROM catalogue_requests WHERE id = ${id}`
  assert.equal(row.status, "rejected")
  assert.equal(row.product_id, null)
  assert.equal(row.staff_note, "trip sudah tutup")
})

test("convertCatalogueRequest on a WhatsApp row uses the send's SNAPSHOT price, not the live (repriced) product, and queues a ✅", async () => {
  // A resolved identity — a real customers row, not the raw-phone-number
  // fallback — since convertCatalogueRequest now refuses an unresolved one
  // (see the "refuses" test below).
  const HANDLE = `wabuyer${process.hrtime.bigint()}`
  extraCustomers.push(HANDLE)
  await sql`INSERT INTO customers (instagram_id) VALUES (${HANDLE}) ON CONFLICT DO NOTHING`

  const { id } = await createDirectClaim({
    customerHandle: HANDLE, productId, qty: 2, note: "t",
    sendId, sendCodeId, sender: "628188888888", messageId: id("her-8"),
  })

  // Reprice the live product AFTER the send already snapshotted its price
  // (100000, set when attachProductToSend ran in before()) — proves
  // convertCatalogueRequest reads wa_send_codes.price, not the live
  // products.price, for a WhatsApp-sourced row.
  await sql`UPDATE products SET price = 250000 WHERE id = ${productId}`
  try {
    const { orderId } = await convertCatalogueRequest(id, EVENT, "test@owner")

    const [order] = await sql`SELECT unit_price, unit, event FROM orders WHERE id = ${orderId}`
    assert.equal(Number(order.unit_price), 100000, "must use the send's snapshot price, not the repriced live product")
    assert.equal(order.unit, 2)
    assert.equal(order.event, EVENT)

    const [reply] = await sql`SELECT reaction FROM wa_replies WHERE quoted_message_id = ${id("her-8")}`
    assert.equal(reply?.reaction, "✅")
  } finally {
    await sql`UPDATE products SET price = 100000 WHERE id = ${productId}`
  }
})

test("convertCatalogueRequest refuses a WhatsApp row whose identity was never resolved to a customer", async () => {
  const { id } = await createDirectClaim({
    customerHandle: `unresolved${process.hrtime.bigint()}`, productId, qty: 1, note: "t",
    sendId, sendCodeId, sender: "628100000099", messageId: id("her-10"),
  })
  await assert.rejects(convertCatalogueRequest(id, EVENT, "test@owner"))
  const [row] = await sql`SELECT status, converted_order_id FROM catalogue_requests WHERE id = ${id}`
  assert.equal(row.status, "pending", "a refused conversion must not touch the row's status")
  assert.equal(row.converted_order_id, null)
})

test("rejectCatalogueRequest on a WhatsApp row queues a ❌", async () => {
  const { id } = await createDirectClaim({
    customerHandle: "628199999999", productId, qty: 1, note: "t",
    sendId, sendCodeId, sender: "628199999999", messageId: id("her-9"),
  })
  await rejectCatalogueRequest(id, "out of stock")
  const [reply] = await sql`SELECT reaction FROM wa_replies WHERE quoted_message_id = ${id("her-9")}`
  assert.equal(reply?.reaction, "❌")
})

test("rejectCatalogueRequest on a catalogue-web row still queues nothing (no message_id to react to)", async () => {
  await createCatalogueRequest({ customerHandle: "web_user", productId, qty: 1, note: "t" }, sql)
  const [{ id }] = await sql`SELECT id FROM catalogue_requests WHERE customer_handle = 'web_user'`
  const before = await sql`SELECT count(*)::int AS n FROM wa_replies`
  await rejectCatalogueRequest(id, "n/a")
  const after = await sql`SELECT count(*)::int AS n FROM wa_replies`
  assert.equal(after[0].n, before[0].n)
})

test("getCatalogueRequests includes source/resolvedCode for a pending WhatsApp row", async () => {
  const { id } = await createDirectClaim({
    customerHandle: "628177000001", productId, qty: 1, note: "K42 mau 1",
    sendId, sendCodeId, sender: "628177000001", messageId: id("her-t1"),
  })
  const rows = await getCatalogueRequests(true)
  const row = rows.find((r) => r.id === id)
  assert.ok(row, "the whatsapp row must appear in the default pending view")
  assert.equal(row.source, "whatsapp")
  assert.ok(row.resolvedCode, "resolvedCode must be populated for a resolved row")
  assert.equal(row.resolvedCodeSendId, sendId)
  assert.equal(row.candidates, null)
})

test("getCatalogueRequests includes candidates for an asking row", async () => {
  const codeB = await attachProductToSend(sendId, productBId)
  const { id } = await createAskingRequest({
    customerHandle: "628177000002", qty: 1, note: "yang mana ya",
    sendId, sender: "628177000002", messageId: id("her-t2"), botMessageId: "bot-t2",
    candidateSendCodeIds: [sendCodeId, codeB.id],
  })
  const rows = await getCatalogueRequests(true)
  const row = rows.find((r) => r.id === id)
  assert.ok(row, "an asking row must appear in the default pending view (asking added to the status filter)")
  assert.equal(row.status, "asking")
  assert.equal(row.resolvedCode, null)
  assert.ok(row.candidates)
  assert.equal(row.candidates!.length, 2)
  const candidateIds = row.candidates!.map((c) => c.id).sort((a, b) => a - b)
  assert.deepEqual(candidateIds, [sendCodeId, codeB.id].sort((a, b) => a - b))
})

test("getCatalogueRequests(false) still includes a rejected closed-trip row, but true does not", async () => {
  const { id } = await createRejectedClaim({
    customerHandle: "628177000003", qty: 1, note: "A21 mau 1",
    sendId, sender: "628177000003", messageId: id("her-t3"),
  })
  const pending = await getCatalogueRequests(true)
  assert.equal(pending.some((r) => r.id === id), false)
  const all = await getCatalogueRequests(false)
  const row = all.find((r) => r.id === id)
  assert.ok(row)
  assert.equal(row.status, "rejected")
})

// See the final whole-branch review's finding 1: createAskingRequest's
// spec'd zero-candidate shape (candidate_send_code_ids: []) — "no code, no
// candidate at all" — was only ever covered by the 2-candidate case above.
// This pins down exactly what the UI actually has to branch on: candidates
// stays null (never an empty array), same as a row with no
// candidate_send_code_ids at all — toRequest's `candidateIds.length > 0`
// guard collapses both shapes.
test("getCatalogueRequests reports null (not an empty array) candidates for a zero-candidate asking row", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628177000004", qty: 1, note: "ada baju baru?",
    sendId, sender: "628177000004", messageId: id("her-t4"), botMessageId: "bot-t4",
    candidateSendCodeIds: [],
  })
  const rows = await getCatalogueRequests(true)
  const row = rows.find((r) => r.id === id)
  assert.ok(row, "a zero-candidate asking row must still appear in the default pending view")
  assert.equal(row.status, "asking")
  assert.deepEqual(row.candidateSendCodeIds, [])
  assert.equal(row.candidates, null, "zero candidates must read as null, not []")
})

// The owner's only action on a zero-candidate asking row (finding 1's UI
// fix): Tolak. product_id is NULL and description is '' on such a row —
// legal only while status = 'asking' (catalogue_requests_product_or_
// description) — so this also exercises rejectCatalogueRequest's new
// description-backfill, without which this UPDATE would violate that check
// constraint the moment status leaves 'asking'.
test("rejectCatalogueRequest can Tolak a zero-candidate asking row", async () => {
  const { id } = await createAskingRequest({
    customerHandle: "628177000005", qty: 1, note: "ada baju baru kah",
    sendId, sender: "628177000005", messageId: id("her-t5"), botMessageId: "bot-t5",
    candidateSendCodeIds: [],
  })
  await rejectCatalogueRequest(id, "")
  const [row] = await sql`SELECT status, product_id, description FROM catalogue_requests WHERE id = ${id}`
  assert.equal(row.status, "rejected")
  assert.equal(row.product_id, null)
  assert.equal(row.description, "ada baju baru kah", "description must backfill from note so the check constraint still holds outside 'asking'")
})

// See finding 4: a WhatsApp row's trip is authoritatively known from
// wa_sends.event via send_id — surfaced as resolvedEvent — never from
// defaultEvent (always null for a WhatsApp row, since post_id is always
// null there).
test("getCatalogueRequests surfaces resolvedEvent from wa_sends for a WhatsApp row", async () => {
  const { id } = await createDirectClaim({
    customerHandle: "628177000006", productId, qty: 1, note: "K42 mau 1",
    sendId, sendCodeId, sender: "628177000006", messageId: id("her-t6"),
  })
  const rows = await getCatalogueRequests(true)
  const row = rows.find((r) => r.id === id)
  assert.ok(row)
  assert.equal(row.defaultEvent, null, "a WhatsApp row's post_id is always null, so defaultEvent stays null")
  assert.equal(row.resolvedEvent, EVENT)
})
