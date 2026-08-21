import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "@/lib/db-pool"
import { createSend, attachProductToSend, setSendMessageId } from "@/lib/db/wa-sends"
import { resolveProductPostClaim } from "./product-post"

// Message ids are literals like id("her-1"), and four test files use the same ones
// against one database while running in parallel — so a row this file inserts
// can be read back as another file's. TAG makes them unique per file per run;
// id() is how every id in this file is written.
const TAG = `${process.hrtime.bigint()}-`
const id = (s: string) => TAG + s

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
  await setSendMessageId(sendId, id("post-msg-1"), GROUP)
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
    groupJid: GROUP, messageId: id("her-1"), sender: HER, text: `${codeA} mau 1`, quoted: "",
  })
  assert.equal(result.kind, "reacted")
  if (result.kind === "reacted") assert.equal(result.emoji, "📝")
  const [row] = await sql`SELECT status, product_id, qty FROM catalogue_requests WHERE message_id = ${id("her-1")}`
  assert.equal(row.status, "pending")
  assert.equal(row.product_id, productAId)
  assert.equal(row.qty, 1)
})

test("a code reply, quoted to the post, resolves the same way", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: id("her-2"), sender: HER, text: `${codeB} mau 2`, quoted: id("post-msg-1"),
  })
  assert.equal(result.kind, "reacted")
  const [row] = await sql`SELECT product_id, qty FROM catalogue_requests WHERE message_id = ${id("her-2")}`
  assert.equal(row.product_id, productBId)
  assert.equal(row.qty, 2)
})

test("an exact unique store-code token, with no minted code, is a direct claim", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: id("her-3"), sender: HER, text: "fix 2099A1 kak, 1 aja", quoted: "",
  })
  assert.equal(result.kind, "reacted")
  if (result.kind === "reacted") assert.equal(result.emoji, "📝")
  const [row] = await sql`SELECT product_id, status FROM catalogue_requests WHERE message_id = ${id("her-3")}`
  assert.equal(row.product_id, productAId)
  assert.equal(row.status, "pending")
})

test("an unrecognised code reacts sad and writes no row", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: id("her-4"), sender: HER, text: "Z99 mau 1", quoted: "",
  })
  assert.equal(result.kind, "reacted")
  if (result.kind === "reacted") assert.equal(result.emoji, "😢")
  const [row] = await sql`SELECT 1 FROM catalogue_requests WHERE message_id = ${id("her-4")}`
  assert.equal(row, undefined)
})

test("a question naming a code, unquoted, is not read as a claim", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: id("her-q1"), sender: HER, text: `Tapi yang ${codeA} ada ukuran apa aja?`, quoted: "",
  })
  assert.equal(result.kind, "question")
  const [row] = await sql`SELECT 1 FROM catalogue_requests WHERE message_id = ${id("her-q1")}`
  assert.equal(row, undefined)
})

test("a question that also states ordering intent still claims normally", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: id("her-q2"), sender: HER, text: `${codeA} ada ukuran apa aja, mau 1`, quoted: "",
  })
  assert.equal(result.kind, "reacted")
  if (result.kind === "reacted") assert.equal(result.emoji, "📝")
  const [row] = await sql`SELECT product_id FROM catalogue_requests WHERE message_id = ${id("her-q2")}`
  assert.equal(row.product_id, productAId)
})

test("a question-shaped reply, quoted to the post, still claims — quoting is its own engagement signal", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: id("her-q3"), sender: HER, text: `${codeB} ada size apa ya?`, quoted: id("post-msg-1"),
  })
  assert.equal(result.kind, "reacted")
  if (result.kind === "reacted") assert.equal(result.emoji, "📝")
  const [row] = await sql`SELECT product_id FROM catalogue_requests WHERE message_id = ${id("her-q3")}`
  assert.equal(row.product_id, productBId)
})

test("a message quoting a closed trip's send is refused", async () => {
  const closedEvent = `${EVENT}-closed`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${closedEvent}, id FROM warehouses ORDER BY id LIMIT 1`
  const closedSend = await createSend({ postId, event: closedEvent, title: "old trip" })
  await setSendMessageId(closedSend.id, "old-post-msg", GROUP)
  // The group is now bound to EVENT, not closedEvent — quoting the old post
  // resolves to closedEvent's send, which is not the group's live one.
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: id("her-5"), sender: HER, text: "A21 mau 1", quoted: "old-post-msg",
  })
  assert.equal(result.kind, "reacted")
  if (result.kind === "reacted") assert.equal(result.emoji, "❌")
  const [row] = await sql`SELECT status FROM catalogue_requests WHERE message_id = ${id("her-5")}`
  assert.equal(row.status, "rejected")
  await sql`DELETE FROM wa_sends WHERE id = ${closedSend.id}`
  await sql`DELETE FROM events WHERE name = ${closedEvent}`
})

test("unquoted chatter with an open send but zero engagement falls through untouched, not a disambiguation ask", async () => {
  // No code, no quote of the send's own post, and (per the fixture product
  // names) no plausible name candidate either — before this fix, this used
  // to come back needsDisambiguation with an empty candidate list, which
  // meant ordinary group chatter ("halo kak", "ini ready kapan") earned a
  // quoted "Kodenya yang mana kak?" reply and a permanent 'asking' row for
  // every such message while any send was open.
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: id("her-6"), sender: HER, text: "ini ready berapa hari lagi ya kak", quoted: "",
  })
  assert.equal(result.kind, "notApplicable")
  const [row] = await sql`SELECT 1 FROM catalogue_requests WHERE message_id = ${id("her-6")}`
  assert.equal(row, undefined)
})

test("quoting the send's own post with no code and no candidate still asks — she engaged with it", async () => {
  // Same text and same zero-candidate outcome as the previous test, but
  // this time she quoted the post itself, which is a real engagement
  // signal — the ❔ ask must still happen here.
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: id("her-6b"), sender: HER, text: "ini ready berapa hari lagi ya kak", quoted: id("post-msg-1"),
  })
  assert.equal(result.kind, "needsDisambiguation")
  if (result.kind === "needsDisambiguation") assert.deepEqual(result.candidates, [])
  // As before, this function only decides there IS an ambiguity — it writes
  // nothing itself.
  const [row] = await sql`SELECT 1 FROM catalogue_requests WHERE message_id = ${id("her-6b")}`
  assert.equal(row, undefined)
})

test("a generic short product-name token does not substring-match an unrelated word", async () => {
  // Both fixture products' names contain the token "bag" ("... Bag Brown").
  // Before word-boundary matching, "bagus" substring-matched "bag" and (as
  // the only match) this became a direct pending order claim for two units
  // of a product she never named.
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: id("her-11"), sender: HER, text: "kakak mau 2 yang bagus", quoted: "",
  })
  assert.equal(result.kind, "notApplicable", "'bagus' must not word-boundary-match the 'bag' token")
  const [row] = await sql`SELECT 1 FROM catalogue_requests WHERE message_id = ${id("her-11")}`
  assert.equal(row, undefined)
})

test("two valid codes in one message ask which one, instead of falling through to name matching", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: id("her-12"), sender: HER, text: `${codeA} sama ${codeB} masing-masing 1`, quoted: "",
  })
  assert.equal(result.kind, "needsDisambiguation")
  if (result.kind !== "needsDisambiguation") return
  assert.deepEqual(result.candidates.map((c) => c.code).sort(), [codeA, codeB].sort())
  const [row] = await sql`SELECT 1 FROM catalogue_requests WHERE message_id = ${id("her-12")}`
  assert.equal(row, undefined, "resolveProductPostClaim itself writes nothing")
})

test("two codes where only one actually resolves offers just the one that did", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: id("her-13"), sender: HER, text: `${codeA} atau Z99, mana ada`, quoted: "",
  })
  assert.equal(result.kind, "needsDisambiguation")
  if (result.kind !== "needsDisambiguation") return
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].code, codeA)
})

test("token matching against an OLDER still-open send of the same trip also resolves as a direct claim, with send_id from that older send", async () => {
  // A second, older send of the same trip — set up and torn down within
  // this one test so it doesn't grow the token-matching pool for every
  // other test in this file. getOpenSendForGroup only ever resolves to the
  // NEWEST send (the fixture `sendId` from before()); this older one must
  // still be reachable by name/token matching, since a trip can have more
  // than one live post at once.
  const olderSend = await createSend({ postId, event: EVENT, title: "earlier restock" })
  const [productC] = await sql`
    INSERT INTO products (name, store, price) VALUES ('Uniquely Distinctive Tumbler', 'ZHG', 50000) RETURNING id
  `
  const productCId = productC.id as number
  await attachProductToSend(olderSend.id, productCId)
  await setSendMessageId(olderSend.id, "old-post-1", GROUP)

  try {
    const result = await resolveProductPostClaim({
      groupJid: GROUP, messageId: id("her-14"), sender: HER, text: "tumbler nya mau 1", quoted: "",
    })
    assert.equal(result.kind, "reacted")
    if (result.kind === "reacted") assert.equal(result.emoji, "📝")
    const [row] = await sql`SELECT product_id, send_id FROM catalogue_requests WHERE message_id = ${id("her-14")}`
    assert.equal(row.product_id, productCId)
    // The row's send_id must come from the send the matched product code
    // actually belongs to (the older send), not from whichever send
    // getOpenSendForGroup picked for the closed-trip check (the newer one).
    assert.equal(row.send_id, olderSend.id)
  } finally {
    await sql`DELETE FROM catalogue_requests WHERE message_id = ${id("her-14")}`
    await sql`DELETE FROM wa_send_codes WHERE send_id = ${olderSend.id}`
    await sql`DELETE FROM wa_sends WHERE id = ${olderSend.id}`
    await sql`DELETE FROM catalogue_post_products WHERE post_id = ${postId} AND product_id = ${productCId}`
    await sql`DELETE FROM products WHERE id = ${productCId}`
  }
})

test("ordinary chat with no group bound to any send is not a product-post claim at all", async () => {
  const emptyGroup = `${process.hrtime.bigint()}-empty@g.us`
  const result = await resolveProductPostClaim({
    groupJid: emptyGroup, messageId: id("her-7"), sender: HER, text: "halo semua", quoted: "",
  })
  assert.equal(result.kind, "notApplicable")
})

test("a question matched by product-name token, not a code, also reacts ❓ not a claim", async () => {
  const result = await resolveProductPostClaim({
    groupJid: GROUP, messageId: id("her-q4"), sender: HER, text: "yang rorojen itu ada warna lain?", quoted: "",
  })
  assert.equal(result.kind, "question")
  const [row] = await sql`SELECT 1 FROM catalogue_requests WHERE message_id = ${id("her-q4")}`
  assert.equal(row, undefined)
})
