import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { FIXTURES } from "../claims/fixtures"
import { createPost, listClaims, listSlots } from "../db/claims"
import { ingestImageReply } from "./ingest"

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
