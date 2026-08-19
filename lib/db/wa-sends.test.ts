import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "@/lib/db-pool"
import {
  createSend, getSend, listSendCodes, attachProductToSend,
  getSendCodeByCode, getOpenSendForGroup, getSendByMessage, setSendMessageId,
} from "./wa-sends"

const EVENT = `TESTSEND${process.hrtime.bigint()}`
const GROUP = `${process.hrtime.bigint()}@g.us`
let postId: number
let productAId: number
let productBId: number

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  const [post] = await sql`
    INSERT INTO catalogue_posts (media_url, media_type) VALUES ('https://example.com/t.jpg', 'photo')
    RETURNING id
  `
  postId = post.id as number
  const [a] = await sql`INSERT INTO products (name, store, price) VALUES ('Test Bag A', 'ZHG', 100000) RETURNING id`
  const [b] = await sql`INSERT INTO products (name, store, price) VALUES ('Test Bag B', 'ZHG', 200000) RETURNING id`
  productAId = a.id as number
  productBId = b.id as number
})

after(async () => {
  await sql`DELETE FROM wa_sends WHERE event = ${EVENT}`
  await sql`DELETE FROM catalogue_post_products WHERE post_id = ${postId}`
  await sql`DELETE FROM catalogue_posts WHERE id = ${postId}`
  await sql`DELETE FROM products WHERE id IN (${productAId}, ${productBId})`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

test("creating a send and attaching two products issues sequential codes", async () => {
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "MUJI restock" })

  const send = await getSend(sendId)
  assert.equal(send?.title, "MUJI restock")
  assert.equal(send?.event, EVENT)

  const codeA = await attachProductToSend(sendId, productAId)
  assert.equal(codeA.code, "A01")
  assert.equal(codeA.price, 100000)

  const codeB = await attachProductToSend(sendId, productBId)
  assert.equal(codeB.code, "A02")

  const codes = await listSendCodes(sendId)
  assert.equal(codes.length, 2)

  // Tagging the product on catalogue_post_products is a side effect of attaching.
  const [tag] = await sql`SELECT 1 FROM catalogue_post_products WHERE post_id = ${postId} AND product_id = ${productAId}`
  assert.ok(tag, "attaching a product tags it on the underlying post")
})

test("attaching an already-tagged product does not duplicate the tag", async () => {
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "Repost" })
  await attachProductToSend(sendId, productAId)
  await attachProductToSend(sendId, productBId) // a second, distinct product on the same send
  const [{ count }] = await sql`SELECT count(*)::int FROM catalogue_post_products WHERE post_id = ${postId} AND product_id = ${productAId}`
  assert.equal(count, 1)
})

test("getSendCodeByCode resolves within the right event only", async () => {
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "t" })
  const issued = await attachProductToSend(sendId, productAId)

  const found = await getSendCodeByCode(EVENT, issued.code)
  assert.equal(found?.id, issued.id)

  const notFound = await getSendCodeByCode(`${EVENT}-other`, issued.code)
  assert.equal(notFound, null)
})

test("getOpenSendForGroup resolves via the group's bound event", async () => {
  await sql`
    INSERT INTO wa_groups (jid, event) VALUES (${GROUP}, ${EVENT})
    ON CONFLICT (jid) DO UPDATE SET event = EXCLUDED.event
  `
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "t" })
  await setSendMessageId(sendId, "msg-1", GROUP)

  const open = await getOpenSendForGroup(GROUP)
  assert.equal(open?.id, sendId)

  // Clean up this send too, not just the group binding: otherwise it lingers
  // as an already-posted send for EVENT and contaminates the next test,
  // which relies on there being no open send for a fresh group binding.
  await sql`DELETE FROM wa_sends WHERE id = ${sendId}`
  await sql`DELETE FROM wa_groups WHERE jid = ${GROUP}`
})

test("getOpenSendForGroup ignores a send that was never actually posted", async () => {
  await sql`
    INSERT INTO wa_groups (jid, event) VALUES (${GROUP}, ${EVENT})
    ON CONFLICT (jid) DO UPDATE SET event = EXCLUDED.event
  `
  await createSend({ postId, event: EVENT, title: "drafted, never sent" })
  const open = await getOpenSendForGroup(GROUP)
  assert.equal(open, null, "a draft with no message_id has not gone out yet")
  await sql`DELETE FROM wa_groups WHERE jid = ${GROUP}`
})

test("setSendMessageId records the message id and group", async () => {
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "t" })
  await setSendMessageId(sendId, "msg-42", GROUP)
  const send = await getSend(sendId)
  assert.equal(send?.messageId, "msg-42")
  assert.equal(send?.groupJid, GROUP)
})

test("getSendByMessage resolves a quoted post back to its send", async () => {
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "t" })
  await setSendMessageId(sendId, "msg-99", GROUP)
  const found = await getSendByMessage(GROUP, "msg-99")
  assert.equal(found?.id, sendId)
})
