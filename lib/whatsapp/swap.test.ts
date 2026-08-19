import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { FIXTURES } from "../claims/fixtures"
import { createPost, addClaim, listClaims, listSlots } from "../db/claims"
import { recluster } from "./ingest"
import { swapClaimSize } from "./swap"
import { recordOffer, findOffer, answerOffer } from "./offers"

const EVENT = `TESTSWAP${process.hrtime.bigint()}`
const GROUP = `${process.hrtime.bigint()}@g.us`
const HER = "628111019159"
const SOMEONE_ELSE = "628119045000"

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
})

after(async () => {
  await sql`DELETE FROM wa_posts WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

/** One shelf, one claim at one spot, with whatever the customer wrote. */
async function shelfWithClaim(note: string, sender = HER) {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: FIXTURES.original, imageWidth: 1600, imageHeight: 2133,
    store: "Nishimatsuya", countryId: null, pricingMethod: null, note: "", safeHues: [130],
  })
  const { id: claimId } = await addClaim({
    postId, sender, customer: null, source: "ink", point: { x: 0.4, y: 0.5 },
    variantId: null, quantity: 1, note, confidence: 1, state: "pending", messageId: "claim-1",
  })
  await recluster(postId)
  return { postId, claimId }
}

test("a swap moves the claim onto the agreed size, creating that slot", async () => {
  const { postId, claimId } = await shelfWithClaim("size 95, kalau nggak ada 100 juga boleh")

  const before = await listSlots(postId)
  assert.equal(before.length, 1)
  assert.equal(before[0].size, "95", "she is filed under the size she asked for")

  await swapClaimSize(claimId, "100")

  const after = await listSlots(postId)
  assert.equal(after.length, 1, "her old size had no other claimant, so that slot is gone")
  assert.equal(after[0].size, "100")
  assert.deepEqual(
    after[0].point, before[0].point,
    "the item hangs where it hung — only the size changed",
  )
})

test("the note keeps her words and gains the agreement", async () => {
  const { postId, claimId } = await shelfWithClaim("size 95 ya kak")
  await swapClaimSize(claimId, "100")

  const [claim] = await listClaims(postId)
  assert.equal(claim.note, "size 95 ya kak → Size 100")
  assert.equal(claim.size, "100", "the column is what the code acts on")
})

test("swapping twice replaces the agreement rather than stacking arrows", async () => {
  const { postId, claimId } = await shelfWithClaim("size 95 ya kak")
  await swapClaimSize(claimId, "100")
  await swapClaimSize(claimId, "110")

  const [claim] = await listClaims(postId)
  assert.equal(claim.note, "size 95 ya kak → Size 110")
  assert.equal(claim.size, "110")
})

test("a swapped claim survives the next recluster", async () => {
  // Reclustering re-reads every claim, and the note still says 95 — deliberately,
  // since that is what her invoice shows. Only the column stops her drifting back.
  const { postId, claimId } = await shelfWithClaim("size 95")
  await swapClaimSize(claimId, "100")
  await recluster(postId)

  const slots = await listSlots(postId)
  assert.equal(slots[0].size, "100")
})

test("two claimants at one peg split by size, one of them swapped", async () => {
  const { postId, claimId } = await shelfWithClaim("size 95")
  await addClaim({
    postId, sender: SOMEONE_ELSE, customer: null, source: "ink", point: { x: 0.4, y: 0.5 },
    variantId: null, quantity: 1, note: "size 95", confidence: 1, state: "pending",
    messageId: "claim-2",
  })
  await recluster(postId)
  assert.equal((await listSlots(postId)).length, 1, "both want 95, so it is one slot")

  await swapClaimSize(claimId, "100")

  const slots = await listSlots(postId)
  assert.deepEqual(slots.map((s) => s.size).sort(), ["100", "95"])
  assert.ok(slots.every((s) => s.claimed === 1), "one claimant each")
})

test("a named slot refuses the swap, because its product carries the size", async () => {
  const { postId, claimId } = await shelfWithClaim("size 95")
  const [slot] = await listSlots(postId)
  await sql`UPDATE wa_slots SET product_id = 1 WHERE id = ${slot.id}`

  await assert.rejects(() => swapClaimSize(claimId, "100"), /already been named/)

  const [claim] = await listClaims(postId)
  assert.equal(claim.size, null, "a refused swap must leave the claim untouched")
  assert.equal(claim.note, "size 95")
})

test("nonsense is not a size", async () => {
  const { claimId } = await shelfWithClaim("size 95")
  await assert.rejects(() => swapClaimSize(claimId, "mau 2"), /not a size/)
})

test("only the claimant can accept an offer made to her", async () => {
  const { postId, claimId } = await shelfWithClaim("size 95")
  await recordOffer({ claimId, size: "100", groupJid: GROUP, messageId: "offer-1" })

  const offer = await findOffer(GROUP, "offer-1")
  assert.ok(offer)
  assert.equal(
    await answerOffer({ offer, reactorNumber: SOMEONE_ELSE, accepted: true }), false,
    "somebody else's thumb must not move her order",
  )

  const [untouched] = await listClaims(postId)
  assert.equal(untouched.size, null)

  assert.equal(await answerOffer({ offer, reactorNumber: HER, accepted: true }), true)
  const [swapped] = await listClaims(postId)
  assert.equal(swapped.size, "100")
})

test("declining leaves her on the size she asked for, still short", async () => {
  const { postId, claimId } = await shelfWithClaim("size 95")
  await recordOffer({ claimId, size: "100", groupJid: GROUP, messageId: "offer-2" })
  const offer = await findOffer(GROUP, "offer-2")
  assert.ok(offer)

  assert.equal(await answerOffer({ offer, reactorNumber: HER, accepted: false }), true)

  const [claim] = await listClaims(postId)
  assert.equal(claim.size, null)
  assert.equal(claim.note, "size 95", "a refusal is not written into her order")
  assert.equal((await listSlots(postId))[0].size, "95")
})

test("an answered offer cannot be answered again", async () => {
  const { claimId } = await shelfWithClaim("size 95")
  await recordOffer({ claimId, size: "100", groupJid: GROUP, messageId: "offer-3" })
  const offer = await findOffer(GROUP, "offer-3")
  assert.ok(offer)

  assert.equal(await answerOffer({ offer, reactorNumber: HER, accepted: false }), true)
  const again = await findOffer(GROUP, "offer-3")
  assert.ok(again)
  assert.equal(
    await answerOffer({ offer: again, reactorNumber: HER, accepted: true }), false,
    "changing her mind is a new offer, not a second answer to the old one",
  )
})

test("the same offer message arriving twice records one offer", async () => {
  const { claimId } = await shelfWithClaim("size 95")
  await recordOffer({ claimId, size: "100", groupJid: GROUP, messageId: "offer-4" })
  await recordOffer({ claimId, size: "110", groupJid: GROUP, messageId: "offer-4" })

  const offer = await findOffer(GROUP, "offer-4")
  assert.equal(offer?.size, "100", "the duplicate carries no new intent")
})
