import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "@/lib/db-pool"
import {
  createSend, getSend, listSendCodes, attachProductToSend,
  getSendCodeByCode, getOpenSendForGroup, getSendByMessage, setSendMessageId,
} from "./wa-sends"

// products has a UNIQUE (name, store). Fixture names are fixed and meaningful
// — the resolver matches tokens inside them — so the store carries the
// uniqueness instead: per file, per run. Without it, one crashed run leaves a
// row behind and every later run fails in before() with a duplicate key.
const STORE = `ZHG-${process.hrtime.bigint()}`

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
  const [a] = await sql`INSERT INTO products (name, store, price) VALUES ('Test Bag A', ${STORE}, 100000) RETURNING id`
  const [b] = await sql`INSERT INTO products (name, store, price) VALUES ('Test Bag B', ${STORE}, 200000) RETURNING id`
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

test("two concurrent attach calls for the SAME product on the SAME send never produce two codes", async () => {
  // Simulates a double-click racing past the client-side alreadyAddedIds
  // guard (which only greys a product out after the round trip AND a
  // follow-up refresh both complete) — see the final whole-branch review's
  // finding 6. Without the unique index + ON CONFLICT handling in
  // attachProductToSend, this either 500s (both computed the same next
  // code) or, worse, silently mints two wa_send_codes rows for the same
  // product under two different codes.
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "double-click race" })
  const [a, b] = await Promise.all([
    attachProductToSend(sendId, productAId),
    attachProductToSend(sendId, productAId),
  ])
  assert.equal(a.id, b.id, "both concurrent calls must settle on the SAME wa_send_codes row")
  assert.equal(a.code, b.code)

  const rows = await sql`SELECT id FROM wa_send_codes WHERE send_id = ${sendId} AND product_id = ${productAId}`
  assert.equal(rows.length, 1, "exactly one code must exist for this (send, product) pair, never two")
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
  // Must have actually gone out — see the dedicated draft test below for the
  // unsent case. A group jid of its own (not the shared GROUP constant),
  // so this doesn't leak a newer "already posted" send into the
  // getOpenSendForGroup tests below that bind GROUP to a fresh draft and
  // expect it to find nothing.
  await setSendMessageId(sendId, "gscbc-msg-1", "gscbc-group@g.us")

  const found = await getSendCodeByCode(EVENT, issued.code)
  assert.equal(found?.id, issued.id)

  const notFound = await getSendCodeByCode(`${EVENT}-other`, issued.code)
  assert.equal(notFound, null)

  // getOpenSendForGroup matches by EVENT (via wa_groups), not by this row's
  // own group_jid — an already-posted send left behind here would silently
  // become "the trip's open send" for every other EVENT-scoped test below
  // that expects no send has gone out yet. Clean it up explicitly.
  await sql`DELETE FROM wa_sends WHERE id = ${sendId}`
})

test("getSendCodeByCode refuses to resolve a code issued on a draft (never-sent) send", async () => {
  // No setSendMessageId call — this send never goes out, matching every
  // abandoned "Simpan draf" session in the composer.
  const { id: sendId } = await createSend({ postId, event: EVENT, title: "draft, never sent" })
  const issued = await attachProductToSend(sendId, productAId)

  const found = await getSendCodeByCode(EVENT, issued.code)
  assert.equal(found, null, "a draft's code must not resolve a real customer's claim")
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

