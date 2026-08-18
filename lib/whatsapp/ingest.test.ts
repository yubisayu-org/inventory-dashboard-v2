import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { FIXTURES } from "../claims/fixtures"
import { createPost, addClaim, listClaims, listSlots } from "../db/claims"
import { ingestImageReply, recluster, matchPostByImage } from "./ingest"

const EVENT = `TESTING${process.hrtime.bigint()}`
const GROUP = `${process.hrtime.bigint()}@g.us`

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

async function shelfPost() {
  return createPost({
    event: EVENT,
    imagePath: FIXTURES.original, // a local path is enough for the resolver
    imageWidth: 1600,
    imageHeight: 2133,
    store: "Nishimatsuya",
    countryId: null,
    pricingMethod: "overseas",
    note: "",
    safeHues: [130],
  })
}

test("a ticked reply becomes one claim per mark", async () => {
  const { id: postId } = await shelfPost()
  const { claimIds } = await ingestImageReply({
    postId, sender: "628111019159", messageId: "m1",
    replyPath: FIXTURES.ticked, caption: "",
  })
  assert.equal(claimIds.length, 2)

  const claims = await listClaims(postId)
  assert.ok(claims.every((c) => c.source === "ink"))
  assert.ok(claims.every((c) => c.point !== null))
})

test("a caption rides along as the claim's note", async () => {
  const { id: postId } = await shelfPost()
  await ingestImageReply({
    postId, sender: "1", messageId: "m2",
    replyPath: FIXTURES.ticked, caption: "size 90 ya kak",
  })
  const claims = await listClaims(postId)
  assert.ok(claims.every((c) => c.note === "size 90 ya kak"))
})

test("a cropped reply becomes one claim at the matched centre", async () => {
  const { id: postId } = await shelfPost()
  const { claimIds } = await ingestImageReply({
    postId, sender: "2", messageId: "m3",
    replyPath: FIXTURES.crop, caption: "",
  })
  assert.equal(claimIds.length, 1)

  const [claim] = await listClaims(postId)
  assert.equal(claim.source, "crop")
  assert.ok(Math.abs((claim.point?.x ?? 0) - 0.615) < 0.08)
})

test("claims near each other cluster into one slot", async () => {
  const { id: postId } = await shelfPost()
  await ingestImageReply({
    postId, sender: "1", messageId: "a", replyPath: FIXTURES.ticked, caption: "",
  })
  await ingestImageReply({
    postId, sender: "2", messageId: "b", replyPath: FIXTURES.ticked, caption: "",
  })

  const slots = await listSlots(postId)
  // Two customers ticking the same two items: two slots, two claims each.
  assert.equal(slots.length, 2)
  assert.ok(slots.every((s) => s.claimed === 2))
})

test("one position with two sizes becomes two SKU", async () => {
  const { id: postId } = await shelfPost()
  await addClaim({
    postId, sender: "1", customer: null, source: "ink", point: { x: 0.4, y: 0.4 },
    variantId: null, quantity: 1, note: "size 90", confidence: 1, state: "pending", messageId: "",
  })
  await addClaim({
    postId, sender: "2", customer: null, source: "ink", point: { x: 0.405, y: 0.4 },
    variantId: null, quantity: 2, note: "yg 95 ya kak", confidence: 1, state: "pending", messageId: "",
  })

  await recluster(postId)

  const slots = await listSlots(postId)
  assert.equal(slots.length, 2, "same spot on the shelf, two things to buy")
  assert.deepEqual(slots.map((s) => s.size).sort(), ["90", "95"])
  assert.equal(slots.find((s) => s.size === "95")?.claimed, 2)
})

test("claims that name no size share one unsized SKU", async () => {
  const { id: postId } = await shelfPost()
  await addClaim({
    postId, sender: "1", customer: null, source: "ink", point: { x: 0.7, y: 0.3 },
    variantId: null, quantity: 1, note: "mau 1", confidence: 1, state: "pending", messageId: "",
  })
  await addClaim({
    postId, sender: "2", customer: null, source: "ink", point: { x: 0.705, y: 0.302 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })

  await recluster(postId)

  const slots = await listSlots(postId)
  assert.equal(slots.length, 1)
  assert.equal(slots[0].size, "", "no size is a state, not a guess")
  assert.equal(slots[0].claimed, 2)
})

test("a crop that cannot be placed confidently records no position", async () => {
  // Reply with a photo of something that is not on this shelf. Whatever the
  // matcher settles on, it will not clear its runner-up by much — and a badge
  // dropped on the wrong pyjamas is worse than a claim asking to be placed.
  const { id: postId } = await shelfPost()
  const { claimIds } = await ingestImageReply({
    postId, sender: "9", messageId: "ambiguous",
    replyPath: FIXTURES.original, caption: "",
  })

  const claims = (await listClaims(postId)).filter((c) => claimIds.includes(c.id))
  for (const claim of claims) {
    if (claim.source !== "crop") continue
    if (claim.confidence > 0.15) continue
    assert.equal(claim.point, null, "an unplaceable crop must not invent a position")
    assert.equal(claim.state, "review")
  }
})

test("the same person sending the same marks twice claims them once", async () => {
  // Customers resend when they have not seen an acknowledgement. A bare repeat
  // is the same request sent twice, not a request for two.
  const { id: postId } = await shelfPost()
  const first = await ingestImageReply({
    postId, sender: "628111019159", messageId: "first",
    replyPath: FIXTURES.ticked, caption: "",
  })
  const second = await ingestImageReply({
    postId, sender: "628111019159", messageId: "second",
    replyPath: FIXTURES.ticked, caption: "",
  })

  assert.equal(first.claimIds.length, 2)
  assert.equal(second.claimIds.length, 0, "the repeat adds nothing")

  const slots = await listSlots(postId)
  assert.ok(
    slots.every((s) => s.claimed === 1),
    `each item wanted once, got ${slots.map((s) => s.claimed).join(",")}`,
  )
})

test("a different customer marking the same item is not a repeat", async () => {
  const { id: postId } = await shelfPost()
  await ingestImageReply({
    postId, sender: "628111019159", messageId: "a",
    replyPath: FIXTURES.ticked, caption: "",
  })
  const other = await ingestImageReply({
    postId, sender: "628999888777", messageId: "b",
    replyPath: FIXTURES.ticked, caption: "",
  })

  assert.equal(other.claimIds.length, 2, "two people wanting one thing is two orders")
  const slots = await listSlots(postId)
  assert.ok(slots.every((s) => s.claimed === 2))
})

test("a marked photo finds its own shelf without being replied to", async () => {
  // Customers crop or scribble on a shelf and send it as a fresh image. Until
  // this, those landed nowhere: no claim, no reaction, and someone sure they
  // had ordered.
  const { id: decoy } = await createPost({
    event: EVENT, imagePath: FIXTURES.greenPost, imageWidth: 1280, imageHeight: 960,
    store: "Decoy", countryId: null, pricingMethod: "overseas", note: "",
    safeHues: [], groupJid: GROUP,
  })
  const { id: real } = await createPost({
    event: EVENT, imagePath: FIXTURES.original, imageWidth: 1600, imageHeight: 2133,
    store: "Real", countryId: null, pricingMethod: "overseas", note: "",
    safeHues: [], groupJid: GROUP,
  })

  const match = await matchPostByImage(GROUP, FIXTURES.ticked)
  assert.ok(match, "the marked shelf should be found among the group's recent posts")
  assert.equal(match.post.id, real, "and it should be the shelf that was actually marked")
  assert.equal(match.marks.length, 2)
  assert.ok(decoy > 0)
})

test("a photo of something else matches no shelf", async () => {
  // Its own group: posts from other tests linger, and one of them is the shelf
  // this photo really was marked on — which would be a correct match, not the
  // miss this is checking for.
  const lonely = `${process.hrtime.bigint()}@g.us`
  await createPost({
    event: EVENT, imagePath: FIXTURES.original, imageWidth: 1600, imageHeight: 2133,
    store: "Real", countryId: null, pricingMethod: "overseas", note: "",
    safeHues: [], groupJid: lonely,
  })
  // A different shop entirely. Guessing a shelf here would file the claim
  // against a product the customer never saw. The two frames differ across some
  // 60% of their pixels, well past what a marked copy ever does.
  assert.equal(await matchPostByImage(lonely, FIXTURES.greenTicked), null)
})

test("marking the same spot twice adds nothing, and says it was a repeat", async () => {
  const { id: postId } = await shelfPost()
  const first = await ingestImageReply({
    postId, sender: "628111019159", messageId: "r1",
    replyPath: FIXTURES.ticked, caption: "size 90",
  })
  assert.equal(first.claimIds.length, 2)
  assert.equal(first.repeats, 0)

  // The same customer, the same marks, sent again — a resend, not a second
  // order. Counted rather than silently dropped: the caller has to tell her
  // "already noted" apart from "I could not read that".
  const again = await ingestImageReply({
    postId, sender: "628111019159", messageId: "r2",
    replyPath: FIXTURES.ticked, caption: "size 90 mau 3 yah",
  })
  assert.equal(again.claimIds.length, 0)
  assert.equal(again.repeats, 2)
})

test("a caption asking for three records three, not one", async () => {
  const { id: postId } = await shelfPost()
  await ingestImageReply({
    postId, sender: "62811900001", messageId: "q1",
    replyPath: FIXTURES.ticked, caption: "size 90 mau 3 yah",
  })

  const claims = await listClaims(postId)
  assert.ok(claims.length > 0)
  assert.ok(claims.every((c) => c.quantity === 3), "each marked item is claimed three times over")
})

test("a size in the caption is not mistaken for a quantity", async () => {
  const { id: postId } = await shelfPost()
  await ingestImageReply({
    postId, sender: "62811900002", messageId: "q2",
    replyPath: FIXTURES.ticked, caption: "mau size 100 ya kak",
  })

  const claims = await listClaims(postId)
  assert.ok(claims.every((c) => c.quantity === 1), "a hundred units is not what she asked for")
})
