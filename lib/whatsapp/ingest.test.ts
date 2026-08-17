import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { FIXTURES } from "../claims/fixtures"
import { createPost, addClaim, listClaims, listSlots } from "../db/claims"
import { ingestImageReply, recluster } from "./ingest"

const EVENT = `TESTING${process.hrtime.bigint()}`

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
