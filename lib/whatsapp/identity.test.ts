import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { createPost, addClaim, listClaims } from "../db/claims"
import { findCustomerByNumber, resolveSenders, linkSenderToCustomer } from "./identity"

const EVENT = `TESTID${process.hrtime.bigint()}`
const KNOWN = `known${process.hrtime.bigint()}`
const LATER = `later${process.hrtime.bigint()}`
const NUMBER = "6281122334455"
const OTHER = "6285566778899"

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  // Stored the way a human typed it into the customer record, not normalized.
  await sql`
    INSERT INTO customers (instagram_id, whatsapp) VALUES (${KNOWN}, '0811-2233-4455')
    ON CONFLICT (instagram_id) DO UPDATE SET whatsapp = EXCLUDED.whatsapp
  `
  await sql`INSERT INTO customers (instagram_id) VALUES (${LATER}) ON CONFLICT DO NOTHING`
})

after(async () => {
  await sql`DELETE FROM wa_posts WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id IN (${KNOWN}, ${LATER})`
  await sql.end()
})

async function postWithSenders(senders: string[]) {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: "test/id.jpg", imageWidth: 100, imageHeight: 100,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  for (const sender of senders) {
    await addClaim({
      postId, sender, customer: null, source: "ink", point: { x: 0.5, y: 0.5 },
      variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
    })
  }
  return postId
}

test("a number already on a customer record resolves however it was typed", async () => {
  assert.equal(await findCustomerByNumber(NUMBER), KNOWN)
  assert.equal(await findCustomerByNumber("0811-2233-4455"), KNOWN)
  assert.equal(await findCustomerByNumber("+62 811 2233 4455"), KNOWN)
})

test("an unknown number resolves to nobody, rather than to a new customer", async () => {
  assert.equal(await findCustomerByNumber(OTHER), null)
  const [count] = await sql`
    SELECT COUNT(*)::int AS n FROM customers WHERE whatsapp LIKE ${"%" + OTHER.slice(-8) + "%"}
  `
  assert.equal(count.n, 0, "auto-creating a phone-keyed customer would fork the namespace")
})

test("resolving a post fills in the senders it can and leaves the rest", async () => {
  const postId = await postWithSenders([NUMBER, OTHER])
  const matched = await resolveSenders(postId)
  assert.equal(matched, 1)

  const claims = await listClaims(postId)
  assert.equal(claims.find((c) => c.sender === NUMBER)?.customer, KNOWN)
  assert.equal(claims.find((c) => c.sender === OTHER)?.customer, null)
  assert.equal(claims.find((c) => c.sender === OTHER)?.state, "review", "an unknown sender needs a human")
})

test("linking a number remembers it for every future claim", async () => {
  await linkSenderToCustomer(OTHER, LATER)
  assert.equal(await findCustomerByNumber(OTHER), LATER)

  const postId = await postWithSenders([OTHER])
  assert.equal(await resolveSenders(postId), 1)
  assert.equal((await listClaims(postId))[0].customer, LATER)
})

test("linking backfills the claims that were already waiting", async () => {
  const postId = await postWithSenders([OTHER])
  await sql`UPDATE wa_claims SET customer = NULL, state = 'review' WHERE post_id = ${postId}`
  await linkSenderToCustomer(OTHER, LATER)

  const claims = await listClaims(postId)
  assert.equal(claims[0].customer, LATER, "answering once must not leave old claims stranded")
})
