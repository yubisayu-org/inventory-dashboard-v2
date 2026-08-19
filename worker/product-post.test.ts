import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "@/lib/db-pool"
import { createSend, attachProductToSend, setSendMessageId } from "@/lib/db/wa-sends"
import { resolveProductPostClaim } from "./product-post"

const EVENT = `TESTPPCLAIM${process.hrtime.bigint()}`
const GROUP = `${process.hrtime.bigint()}@g.us`
const HER = "628111111111"
let postId: number
let productAId: number
let productBId: number
let sendId: number
let codeA: string
let codeB: string

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  await sql`INSERT INTO wa_groups (jid, event, active) VALUES (${GROUP}, ${EVENT}, true) ON CONFLICT (jid) DO UPDATE SET event = EXCLUDED.event`
  const [post] = await sql`INSERT INTO catalogue_posts (media_url, media_type) VALUES ('https://example.com/t.jpg', 'photo') RETURNING id`
  postId = post.id as number
  const [a] = await sql`INSERT INTO products (name, store, price) VALUES ('2099A1 - Buckle Shoulder Bag Brown', 'ZHG', 840000) RETURNING id`
  const [b] = await sql`INSERT INTO products (name, store, price) VALUES ('30213 - Rorojen Bag Brown', 'ZHG', 920000) RETURNING id`
  productAId = a.id as number
  productBId = b.id as number

  const send = await createSend({ postId, event: EVENT, title: "ZHG restock" })
  sendId = send.id
  codeA = (await attachProductToSend(sendId, productAId)).code
  codeB = (await attachProductToSend(sendId, productBId)).code
  await setSendMessageId(sendId, "post-msg-1", GROUP)
})

after(async () => {
  await sql`DELETE FROM catalogue_requests WHERE send_id = ${sendId}`
  await sql`DELETE FROM wa_send_codes WHERE send_id = ${sendId}`
  await sql`DELETE FROM wa_sends WHERE id = ${sendId}`
  await sql`DELETE FROM catalogue_post_products WHERE post_id = ${postId}`
  await sql`DELETE FROM catalogue_posts WHERE id = ${postId}`
  await sql`DELETE FROM products WHERE id IN (${productAId}, ${productBId})`
  await sql`DELETE FROM wa_groups WHERE jid = ${GROUP}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

test("a code reply, unquoted, resolves against the group's bound event", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-1", sender: HER, text: `${codeA} mau 1`, quoted: "",
  })
  assert.equal(result.kind, "reacted")
  if (result.kind === "reacted") assert.equal(result.emoji, "📝")
  const [row] = await sql`SELECT status, product_id, qty FROM catalogue_requests WHERE message_id = 'her-1'`
  assert.equal(row.status, "pending")
  assert.equal(row.product_id, productAId)
  assert.equal(row.qty, 1)
})

test("a code reply, quoted to the post, resolves the same way", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-2", sender: HER, text: `${codeB} mau 2`, quoted: "post-msg-1",
  })
  assert.equal(result.kind, "reacted")
  const [row] = await sql`SELECT product_id, qty FROM catalogue_requests WHERE message_id = 'her-2'`
  assert.equal(row.product_id, productBId)
  assert.equal(row.qty, 2)
})

test("an exact unique store-code token, with no minted code, is a direct claim", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-3", sender: HER, text: "fix 2099A1 kak, 1 aja", quoted: "",
  })
  assert.equal(result.kind, "reacted")
  if (result.kind === "reacted") assert.equal(result.emoji, "📝")
  const [row] = await sql`SELECT product_id, status FROM catalogue_requests WHERE message_id = 'her-3'`
  assert.equal(row.product_id, productAId)
  assert.equal(row.status, "pending")
})

test("an unrecognised code reacts sad and writes no row", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-4", sender: HER, text: "Z99 mau 1", quoted: "",
  })
  assert.equal(result.kind, "reacted")
  if (result.kind === "reacted") assert.equal(result.emoji, "😢")
  const [row] = await sql`SELECT 1 FROM catalogue_requests WHERE message_id = 'her-4'`
  assert.equal(row, undefined)
})

test("a message quoting a closed trip's send is refused", async () => {
  const closedEvent = `${EVENT}-closed`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${closedEvent}, id FROM warehouses ORDER BY id LIMIT 1`
  const closedSend = await createSend({ postId, event: closedEvent, title: "old trip" })
  await setSendMessageId(closedSend.id, "old-post-msg", GROUP)
  // The group is now bound to EVENT, not closedEvent — quoting the old post
  // resolves to closedEvent's send, which is not the group's live one.
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-5", sender: HER, text: "A21 mau 1", quoted: "old-post-msg",
  })
  assert.equal(result.kind, "reacted")
  if (result.kind === "reacted") assert.equal(result.emoji, "❌")
  const [row] = await sql`SELECT status FROM catalogue_requests WHERE message_id = 'her-5'`
  assert.equal(row.status, "rejected")
  await sql`DELETE FROM wa_sends WHERE id = ${closedSend.id}`
  await sql`DELETE FROM events WHERE name = ${closedEvent}`
})

test("no code and no candidate returns a disambiguation request with no candidates", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-6", sender: HER, text: "ini ready berapa hari lagi ya kak", quoted: "",
  })
  assert.equal(result.kind, "needsDisambiguation")
  if (result.kind === "needsDisambiguation") assert.deepEqual(result.candidates, [])
  // This function only decides there IS an ambiguity to ask about — it does
  // not write a row itself (Task 9's askDisambiguation does, after posting
  // the question), so no catalogue_requests row exists yet at this point.
  const [row] = await sql`SELECT 1 FROM catalogue_requests WHERE message_id = 'her-6'`
  assert.equal(row, undefined)
})

test("ordinary chat with no group bound to any send is not a product-post claim at all", async () => {
  const emptyGroup = `${process.hrtime.bigint()}-empty@g.us`
  const result = await resolveProductPostClaim({
    groupJid: emptyGroup, messageId: "her-7", sender: HER, text: "halo semua", quoted: "",
  })
  assert.equal(result.kind, "notApplicable")
})
