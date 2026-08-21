import { test, before, after, mock } from "node:test"
import assert from "node:assert/strict"
import sql from "@/lib/db-pool"
import { createSend, attachProductToSend, setSendMessageId } from "@/lib/db/wa-sends"
import { resolveProductPostClaim } from "./product-post"
import { askDisambiguation, trySendOfferAnswer, trySendOfferThumbsUp } from "./product-post-offer"

// products has a UNIQUE (name, store). Fixture names are fixed and meaningful
// — the resolver matches tokens inside them — so the store carries the
// uniqueness instead: per file, per run. Without it, one crashed run leaves a
// row behind and every later run fails in before() with a duplicate key.
const STORE = `MUJI-${process.hrtime.bigint()}`

const EVENT = `TESTPPOFFER${process.hrtime.bigint()}`
const GROUP = `${process.hrtime.bigint()}@g.us`
const HER = "628111111111"
let postId: number
let productAId: number
let productBId: number
let productCId: number
let sendId: number

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  await sql`INSERT INTO wa_groups (jid, event, active) VALUES (${GROUP}, ${EVENT}, true) ON CONFLICT (jid) DO UPDATE SET event = EXCLUDED.event`
  const [post] = await sql`INSERT INTO catalogue_posts (media_url, media_type) VALUES ('https://example.com/t.jpg', 'photo') RETURNING id`
  postId = post.id as number
  const [a] = await sql`INSERT INTO products (name, store, price) VALUES ('Boston Bag 38L Greige', ${STORE}, 385000) RETURNING id`
  const [b] = await sql`INSERT INTO products (name, store, price) VALUES ('Boston Bag 38L Black', ${STORE}, 385000) RETURNING id`
  // A third product whose tokens ("ransel"/"kuning"/"kecil") share nothing
  // with A/B's ("boston"/"bag"/"38l"/"greige"/"black") — used by the
  // one-candidate tests below so a fuzzy (not exact) match reliably narrows
  // to exactly it, without fighting A/B's overlapping tokens. Verified
  // empirically against the real resolver, not assumed.
  const [c] = await sql`INSERT INTO products (name, store, price) VALUES ('Ransel Kuning Kecil', ${STORE}, 250000) RETURNING id`
  productAId = a.id as number
  productBId = b.id as number
  productCId = c.id as number
  const send = await createSend({ postId, event: EVENT, title: "MUJI restock" })
  sendId = send.id
  await attachProductToSend(sendId, productAId)
  await attachProductToSend(sendId, productBId)
  await attachProductToSend(sendId, productCId)
  await setSendMessageId(sendId, "post-msg-1", GROUP)
})

after(async () => {
  await sql`DELETE FROM catalogue_requests WHERE send_id = ${sendId}`
  await sql`DELETE FROM wa_send_codes WHERE send_id = ${sendId}`
  await sql`DELETE FROM wa_sends WHERE id = ${sendId}`
  await sql`DELETE FROM catalogue_post_products WHERE post_id = ${postId}`
  await sql`DELETE FROM catalogue_posts WHERE id = ${postId}`
  await sql`DELETE FROM products WHERE id IN (${productAId}, ${productBId}, ${productCId})`
  await sql`DELETE FROM wa_groups WHERE jid = ${GROUP}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

function fakeSock(sentId: string) {
  return { sendMessage: mock.fn(async () => ({ key: { id: sentId } })) } as any
}

test("askDisambiguation with two candidates lists only the codes, never a bare number", async () => {
  const resolution = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-1", sender: HER, text: "bostonnya mau 1 dong", quoted: "",
  })
  assert.equal(resolution.kind, "needsDisambiguation")
  if (resolution.kind !== "needsDisambiguation") return

  const sock = fakeSock("bot-msg-1")
  const emoji = await askDisambiguation(sock, {
    groupJid: GROUP, messageId: "her-1", sender: HER, text: "bostonnya mau 1 dong", quoted: "",
  }, resolution)
  assert.equal(emoji, "❔")

  const [sent] = sock.sendMessage.mock.calls
  const caption = sent.arguments[1].text as string
  assert.ok(!/balas\s+1\s+atau\s+2/i.test(caption), "must never offer numbered options")

  const [row] = await sql`SELECT status, bot_message_id, candidate_send_code_ids FROM catalogue_requests WHERE message_id = 'her-1'`
  assert.equal(row.status, "asking")
  assert.equal(row.bot_message_id, "bot-msg-1")
  assert.equal(row.candidate_send_code_ids.length, 2)
})

test("askDisambiguation with one candidate asks a yes/no confirmation", async () => {
  // "warna greijnya mau 1" is a typo'd/partial "greige" — it hits the
  // resolver's FUZZY path (prefix match), not the exact-token path, so it
  // narrows to exactly one candidate instead of resolving as a direct claim.
  // A full "greige" would exact-match and short-circuit to "reacted" (see
  // worker/product-post.test.ts's own "exact unique... is a direct claim"
  // case) — verified empirically against the real resolver, not assumed.
  const text = "warna greijnya mau 1"
  const resolution = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-2", sender: HER, text, quoted: "",
  })
  assert.equal(resolution.kind, "needsDisambiguation")
  if (resolution.kind !== "needsDisambiguation") return
  assert.equal(resolution.candidates.length, 1, "fixture text is chosen to fuzzy-match exactly one candidate")

  const sock = fakeSock("bot-msg-2")
  const emoji = await askDisambiguation(sock, {
    groupJid: GROUP, messageId: "her-2", sender: HER, text, quoted: "",
  }, resolution)
  assert.equal(emoji, "❔")

  const [sent] = sock.sendMessage.mock.calls
  const caption = sent.arguments[1].text as string
  assert.ok(/kalau betul/i.test(caption), "single-candidate offer should ask a yes/no confirmation, not list codes")

  const [row] = await sql`SELECT status, bot_message_id, candidate_send_code_ids FROM catalogue_requests WHERE message_id = 'her-2'`
  assert.equal(row.status, "asking")
  assert.equal(row.bot_message_id, "bot-msg-2")
  assert.equal(row.candidate_send_code_ids.length, 1)
})

test("trySendOfferAnswer settles a code reply against the offered candidates only", async () => {
  const resolution = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-3", sender: HER, text: "bostonnya mau 1", quoted: "",
  })
  assert.equal(resolution.kind, "needsDisambiguation")
  if (resolution.kind !== "needsDisambiguation") return
  const sock = fakeSock("bot-msg-3")
  await askDisambiguation(sock, {
    groupJid: GROUP, messageId: "her-3", sender: HER, text: "bostonnya mau 1", quoted: "",
  }, resolution)

  const offeredCode = (await sql`SELECT sc.code FROM catalogue_requests r JOIN wa_send_codes sc ON sc.id = r.candidate_send_code_ids[1] WHERE r.message_id = 'her-3'`)[0].code as string

  const emoji = await trySendOfferAnswer({
    groupJid: GROUP, messageId: "her-3-reply", sender: HER, text: `${offeredCode}`, quoted: "bot-msg-3",
  })
  assert.equal(emoji, "📝")

  const [row] = await sql`SELECT status, product_id FROM catalogue_requests WHERE message_id = 'her-3'`
  assert.equal(row.status, "pending")
})

test("a second answer to an already-resolved offer does nothing", async () => {
  const resolution = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-4", sender: HER, text: "bostonnya mau 1", quoted: "",
  })
  if (resolution.kind !== "needsDisambiguation") return
  const sock = fakeSock("bot-msg-4")
  await askDisambiguation(sock, {
    groupJid: GROUP, messageId: "her-4", sender: HER, text: "bostonnya mau 1", quoted: "",
  }, resolution)
  const offeredCode = (await sql`SELECT sc.code FROM catalogue_requests r JOIN wa_send_codes sc ON sc.id = r.candidate_send_code_ids[1] WHERE r.message_id = 'her-4'`)[0].code as string

  await trySendOfferAnswer({ groupJid: GROUP, messageId: "her-4-a", sender: HER, text: offeredCode, quoted: "bot-msg-4" })
  const emoji = await trySendOfferAnswer({ groupJid: GROUP, messageId: "her-4-b", sender: HER, text: offeredCode, quoted: "bot-msg-4" })
  assert.equal(emoji, null, "the offer is already answered")
})

test("trySendOfferAnswer returns null for a reply quoting no open offer", async () => {
  const emoji = await trySendOfferAnswer({
    groupJid: GROUP, messageId: "her-5", sender: HER, text: "K01", quoted: "not-an-offer",
  })
  assert.equal(emoji, null)
})

test("trySendOfferThumbsUp settles a one-candidate offer", async () => {
  // "kuni nya mau 1" fuzzy-matches only the third fixture product ("Ransel
  // Kuning Kecil"'s "kuning" token, prefix "kuni") — a partial match, not
  // the full word, so it takes the fuzzy path and narrows to exactly one
  // candidate rather than exact-matching and short-circuiting to a direct
  // claim. Verified empirically against the real resolver, not assumed.
  const text = "kuni nya mau 1"
  const resolution = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-6", sender: HER, text, quoted: "",
  })
  assert.equal(resolution.kind, "needsDisambiguation")
  if (resolution.kind !== "needsDisambiguation") return
  assert.equal(resolution.candidates.length, 1, "fixture text is chosen to fuzzy-match exactly one candidate")

  const sock = fakeSock("bot-msg-6")
  await askDisambiguation(sock, {
    groupJid: GROUP, messageId: "her-6", sender: HER, text, quoted: "",
  }, resolution)

  const emoji = await trySendOfferThumbsUp(GROUP, "bot-msg-6", "👍", HER)
  assert.equal(emoji, "✅")
  const [row] = await sql`SELECT status FROM catalogue_requests WHERE message_id = 'her-6'`
  assert.equal(row.status, "pending")
})

test("trySendOfferThumbsUp does nothing for a multi-candidate offer", async () => {
  const resolution = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-7", sender: HER, text: "bostonnya mau 1", quoted: "",
  })
  if (resolution.kind !== "needsDisambiguation") return
  const sock = fakeSock("bot-msg-7")
  await askDisambiguation(sock, {
    groupJid: GROUP, messageId: "her-7", sender: HER, text: "bostonnya mau 1", quoted: "",
  }, resolution)
  const emoji = await trySendOfferThumbsUp(GROUP, "bot-msg-7", "👍", HER)
  assert.equal(emoji, null)
})

test("trySendOfferThumbsUp ignores a reaction that isn't a positive answer (a 👎, or a removed reaction reported as empty text)", async () => {
  const text = "kuni nya mau 1"
  const resolution = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-8", sender: HER, text, quoted: "",
  })
  if (resolution.kind !== "needsDisambiguation") return
  const sock = fakeSock("bot-msg-8")
  await askDisambiguation(sock, {
    groupJid: GROUP, messageId: "her-8", sender: HER, text, quoted: "",
  }, resolution)

  assert.equal(await trySendOfferThumbsUp(GROUP, "bot-msg-8", "👎", HER), null, "a negative reaction must not settle it")
  assert.equal(await trySendOfferThumbsUp(GROUP, "bot-msg-8", "", HER), null, "a removed reaction (empty text) must not settle it")

  const [row] = await sql`SELECT status FROM catalogue_requests WHERE message_id = 'her-8'`
  assert.equal(row.status, "asking", "the offer must still be open — neither reaction was hers agreeing")
})

test("trySendOfferThumbsUp does nothing for somebody else's thumb on her offer", async () => {
  const OTHER = "628199999999"
  const text = "kuni nya mau 1"
  const resolution = await resolveProductPostClaim({
    groupJid: GROUP, messageId: "her-9", sender: HER, text, quoted: "",
  })
  if (resolution.kind !== "needsDisambiguation") return
  const sock = fakeSock("bot-msg-9")
  await askDisambiguation(sock, {
    groupJid: GROUP, messageId: "her-9", sender: HER, text, quoted: "",
  }, resolution)

  const emoji = await trySendOfferThumbsUp(GROUP, "bot-msg-9", "👍", OTHER)
  assert.equal(emoji, null, "a stranger's thumb must not settle another customer's claim")
  const [row] = await sql`SELECT status FROM catalogue_requests WHERE message_id = 'her-9'`
  assert.equal(row.status, "asking")
})

test("trySendOfferThumbsUp rejects an empty quoted-message id outright", async () => {
  assert.equal(await trySendOfferThumbsUp(GROUP, "", "👍", HER), null)
})
