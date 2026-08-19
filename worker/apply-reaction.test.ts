import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../lib/db-pool"
import { addBotAdmin } from "../lib/db/whatsapp-groups"
import { createPost, addClaim, listClaims } from "../lib/db/claims"
import { applyOwnerReaction } from "./outcomes"

const EVENT = `TESTREACT${process.hrtime.bigint()}`
const ADMIN = "628110000021"
const CUSTOMER = "628119999021"
const MESSAGE = `msg${process.hrtime.bigint()}`

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  await addBotAdmin({ number: ADMIN, label: "owner", canConnect: true })
})

after(async () => {
  await sql`DELETE FROM wa_posts WHERE event = ${EVENT}`
  await sql`DELETE FROM wa_admins WHERE number = ${ADMIN}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

/** One reply that ticked three items: three claims, one message id. */
async function postWithThreeMarks() {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: "test/r.jpg", imageWidth: 100, imageHeight: 100,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  for (const x of [0.2, 0.5, 0.8]) {
    await addClaim({
      postId, sender: CUSTOMER, customer: null, source: "ink", point: { x, y: 0.5 },
      variantId: null, quantity: 1, note: "", confidence: 1, state: "pending",
      messageId: MESSAGE,
    })
  }
  return postId
}

test("a tick buys every item that message claimed, not just the first", async () => {
  const postId = await postWithThreeMarks()

  const applied = await applyOwnerReaction({
    reactorJid: `${ADMIN}@s.whatsapp.net`,
    messageId: MESSAGE,
    emoji: "✅",
  })
  assert.equal(applied, true)

  const claims = await listClaims(postId)
  assert.equal(claims.length, 3)
  assert.ok(
    claims.every((c) => c.obtained === 1),
    `three marks in one photo is three things bought, got ${claims.map((c) => c.obtained).join(",")}`,
  )
})

test("a cross closes every claim on the message too", async () => {
  const postId = await postWithThreeMarks()

  await applyOwnerReaction({
    reactorJid: `${ADMIN}@s.whatsapp.net`,
    messageId: MESSAGE,
    emoji: "❌",
  })

  const claims = await listClaims(postId)
  assert.ok(claims.every((c) => c.state === "rejected"))
  assert.ok(claims.every((c) => c.obtained === 0))
})

test("a customer ticking their own claim changes nothing", async () => {
  const postId = await postWithThreeMarks()

  const applied = await applyOwnerReaction({
    reactorJid: `${CUSTOMER}@s.whatsapp.net`,
    messageId: MESSAGE,
    emoji: "✅",
  })
  assert.equal(applied, false, "buying is the owner's word, not the claimant's")

  const claims = await listClaims(postId)
  assert.ok(claims.every((c) => c.obtained === 0))
})
