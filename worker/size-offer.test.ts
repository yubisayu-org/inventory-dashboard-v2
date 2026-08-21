import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "@/lib/db-pool"
import { FIXTURES } from "@/lib/claims/fixtures"
import { createPost, addClaim, listClaims } from "@/lib/db/claims"
import { recluster } from "@/lib/whatsapp/ingest"
import { classifyAnswer, trySizeOffer, trySizeAnswer } from "./size-offer"

// Message ids are literals like mid("her-1"), and four test files use the same ones
// against one database while running in parallel — so a row this file inserts
// can be read back as another file's. TAG makes them unique per file per run;
// mid() is how every message id in this file is written.
const TAG = `${process.hrtime.bigint()}-`
const mid = (s: string) => TAG + s

const EVENT = `TESTOFFER${process.hrtime.bigint()}`
const GROUP = `${process.hrtime.bigint()}@g.us`
const OWNER = "628119990001"
const HER = "628119990002"

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  await sql`
    INSERT INTO wa_admins (number, can_connect) VALUES (${OWNER}, true)
    ON CONFLICT (number) DO NOTHING
  `
})

after(async () => {
  await sql`DELETE FROM wa_posts WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM wa_admins WHERE number = ${OWNER}`
  await sql.end()
})

/** A shelf with one claim, sent as one WhatsApp message. */
async function claimed(note: string, messageId: string, notes: string[] = []) {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: FIXTURES.original, imageWidth: 1600, imageHeight: 2133,
    store: "Nishimatsuya", countryId: null, pricingMethod: null, note: "", safeHues: [130],
  })
  for (const [i, each] of [note, ...notes].entries()) {
    await addClaim({
      postId, sender: HER, customer: null, source: "ink",
      point: { x: 0.3 + i * 0.2, y: 0.5 }, variantId: null, quantity: 1, note: each,
      confidence: 1, state: "pending", messageId,
    })
  }
  await recluster(postId)
  return { postId }
}

test("a thumb is a yes whatever skin tone the keyboard added", () => {
  assert.equal(classifyAnswer("👍"), true)
  assert.equal(classifyAnswer("👍🏽"), true)
  assert.equal(classifyAnswer("👌"), true)
  assert.equal(classifyAnswer("👎"), false)
  assert.equal(classifyAnswer("❌"), false)
  assert.equal(classifyAnswer("😂"), null, "laughing at the offer is not an answer")
  assert.equal(classifyAnswer(""), null)
})

test("a size she offered herself is applied on the spot, no waiting", async () => {
  const { postId } = await claimed("size 95, kalau nggak ada 100 juga boleh", mid("her-1"))

  const emoji = await trySizeOffer({
    groupJid: GROUP, messageId: "owner-1", sender: OWNER,
    text: "95 kosong kak, aku ambil 100 ya", quoted: mid("her-1"),
  })
  assert.equal(emoji, "✅")

  const [claim] = await listClaims(postId)
  assert.equal(claim.size, "100")
  assert.equal(claim.note, "size 95, kalau nggak ada 100 juga boleh → Size 100")
})

test("a size she never mentioned waits for her, changing nothing yet", async () => {
  const { postId } = await claimed("size 95 ya kak", mid("her-2"))

  const emoji = await trySizeOffer({
    groupJid: GROUP, messageId: "owner-2", sender: OWNER,
    text: "95 kosong, adanya 100. Mau?", quoted: mid("her-2"),
  })
  assert.equal(emoji, "❔")

  const [claim] = await listClaims(postId)
  assert.equal(claim.size, null, "an offer is not an agreement")

  const answer = await trySizeAnswer({
    groupJid: GROUP, messageId: "owner-2", reactorJid: `${HER}@s.whatsapp.net`, emoji: "👍",
  })
  assert.equal(answer, "✅")

  const [agreed] = await listClaims(postId)
  assert.equal(agreed.size, "100")
})

test("her thumbs down leaves her at the size she asked for", async () => {
  const { postId } = await claimed("size 95 ya kak", mid("her-3"))
  await trySizeOffer({
    groupJid: GROUP, messageId: "owner-3", sender: OWNER, text: "adanya 100", quoted: mid("her-3"),
  })

  const answer = await trySizeAnswer({
    groupJid: GROUP, messageId: "owner-3", reactorJid: `${HER}@s.whatsapp.net`, emoji: "👎",
  })
  assert.equal(answer, "❌")

  const [claim] = await listClaims(postId)
  assert.equal(claim.size, null)
  assert.equal(claim.note, "size 95 ya kak", "a refusal is not written into her order")
})

test("somebody else's thumb on the offer does nothing", async () => {
  const { postId } = await claimed("size 95 ya kak", mid("her-4"))
  await trySizeOffer({
    groupJid: GROUP, messageId: "owner-4", sender: OWNER, text: "adanya 100", quoted: mid("her-4"),
  })

  const answer = await trySizeAnswer({
    groupJid: GROUP, messageId: "owner-4", reactorJid: "628119990009@s.whatsapp.net", emoji: "👍",
  })
  assert.equal(answer, null)

  const [claim] = await listClaims(postId)
  assert.equal(claim.size, null)
})

test("a customer cannot offer herself a size", async () => {
  const { postId } = await claimed("size 95 ya kak", mid("her-5"))

  const emoji = await trySizeOffer({
    groupJid: GROUP, messageId: "hers-again", sender: HER, text: "100 aja deh", quoted: mid("her-5"),
  })
  assert.equal(emoji, null, "only an admin decides what the shelf has")

  const [claim] = await listClaims(postId)
  assert.equal(claim.size, null)
})

test("a reply naming no size is not an offer", async () => {
  await claimed("size 95 ya kak", mid("her-6"))
  const emoji = await trySizeOffer({
    groupJid: GROUP, messageId: "owner-6", sender: OWNER, text: "oke kak siap", quoted: mid("her-6"),
  })
  assert.equal(emoji, null)
})

test("a message carrying three claims is refused rather than guessed at", async () => {
  const { postId } = await claimed("size 95", mid("her-7"), ["size 95", "size 95"])

  const emoji = await trySizeOffer({
    groupJid: GROUP, messageId: "owner-7", sender: OWNER, text: "adanya 100", quoted: mid("her-7"),
  })
  assert.equal(emoji, "😢", "which of the three she would take is not knowable from '100'")

  const claims = await listClaims(postId)
  assert.ok(claims.every((c) => c.size === null))
})

test("the size she cannot have is not read as the offer", async () => {
  // "95 kosong, ambil 100" names her own size first, because that is how anyone
  // would write it. Taking the first — or the last — is word order pretending to
  // be meaning.
  const { postId } = await claimed("size 95 ya kak", mid("her-8"))
  await trySizeOffer({
    groupJid: GROUP, messageId: "owner-8", sender: OWNER,
    text: "95 kosong kak, adanya 100", quoted: mid("her-8"),
  })
  await trySizeAnswer({
    groupJid: GROUP, messageId: "owner-8", reactorJid: `${HER}@s.whatsapp.net`, emoji: "👍",
  })

  const [claim] = await listClaims(postId)
  assert.equal(claim.size, "100", "the offer is the size that is not already hers")
})

test("two sizes offered at once is a question, not an instruction", async () => {
  const { postId } = await claimed("size 95 ya kak", mid("her-9"))
  const emoji = await trySizeOffer({
    groupJid: GROUP, messageId: "owner-9", sender: OWNER,
    text: "95 kosong, ada 100 atau 110", quoted: mid("her-9"),
  })
  assert.equal(emoji, "😢")

  const [claim] = await listClaims(postId)
  assert.equal(claim.size, null)
})

test("repeating her own size back is not an offer at all", async () => {
  await claimed("size 95 ya kak", mid("her-10"))
  const emoji = await trySizeOffer({
    groupJid: GROUP, messageId: "owner-10", sender: OWNER, text: "95 ya kak siap", quoted: mid("her-10"),
  })
  assert.equal(emoji, null)
})
