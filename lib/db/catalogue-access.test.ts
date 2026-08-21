import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import {
  listPendingAccessRequests,
  approveAccessRequest,
  rejectAccessRequest,
  bulkInviteExistingCustomers,
} from "./catalogue-access"
import { redeemInvite } from "./catalogue-auth"

const TAG = `acctest${process.hrtime.bigint()}`
let n = 0
const handle = () => `${TAG}_${n++}`

async function queueRequest(instagramId: string): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO catalogue_access_requests (instagram_id, note)
    VALUES (${instagramId}, 'test') RETURNING id
  `
  return row.id
}

after(async () => {
  await sql`DELETE FROM catalogue_access_requests WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("approving an unknown handle creates the customer and returns a usable invite", async () => {
  const h = handle()
  const result = await approveAccessRequest(await queueRequest(h))
  assert.equal(result.instagramId, h)
  assert.deepEqual(await redeemInvite(result.token, `${TAG}_sub_${n}`), {
    customerId: result.customerId,
  })
})

test("approving a handle that already has a customer re-issues rather than duplicating", async () => {
  const h = handle()
  const [existing] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${h}) RETURNING id
  `
  const result = await approveAccessRequest(await queueRequest(h))
  assert.equal(result.customerId, existing.id, "must reuse the existing customer")

  const [{ count }] = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count FROM customers WHERE instagram_id = ${h}
  `
  assert.equal(Number(count), 1, "a second row would split their order history")
})

test("the queue flags a handle that already has a customer", async () => {
  const h = handle()
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${h}) RETURNING id
  `
  await queueRequest(h)
  const pending = await listPendingAccessRequests()
  const row = pending.find((r) => r.instagramId === h)
  assert.equal(row?.existingCustomerId, c.id)
})

test("an approved request leaves the pending queue", async () => {
  const h = handle()
  const id = await queueRequest(h)
  await approveAccessRequest(id)
  assert.equal(
    (await listPendingAccessRequests()).some((r) => r.id === id),
    false,
  )
})

test("a request cannot be approved twice", async () => {
  const id = await queueRequest(handle())
  await approveAccessRequest(id)
  await assert.rejects(() => approveAccessRequest(id), /already handled/)
})

test("rejecting removes it from the queue and cannot be repeated", async () => {
  const id = await queueRequest(handle())
  await rejectAccessRequest(id)
  assert.equal((await listPendingAccessRequests()).some((r) => r.id === id), false)
  await assert.rejects(() => rejectAccessRequest(id), /not found or already handled/)
})

test("bulk invite covers customers with orders and skips those already signed in", async () => {
  const withOrders = handle()
  const alreadyBound = handle()
  const noOrders = handle()

  const [a] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${withOrders}) RETURNING id`
  const [b] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id, google_sub, catalogue_access)
    VALUES (${alreadyBound}, ${`${TAG}_bound_sub`}, 'active') RETURNING id`
  await sql`INSERT INTO customers (instagram_id) VALUES (${noOrders})`

  for (const id of [a.id, b.id]) {
    await sql`
      INSERT INTO catalogue_requests (customer_handle, customer_id, qty, description)
      VALUES ('x', ${id}, 1, 'thing')`
  }

  const invited = (await bulkInviteExistingCustomers()).map((i) => i.instagramId)
  assert.ok(invited.includes(withOrders), "has orders, never signed in")
  assert.ok(!invited.includes(alreadyBound), "already has a google account bound")
  assert.ok(!invited.includes(noOrders), "no catalogue history to reach")
})

test("approving claims requests the handle placed before it had a customer row", async () => {
  // The public read path filters on customer_id. Without this the invited
  // customer signs in to an empty history, and an outstanding offer — which
  // approve/reject also match on customer_id — can never be accepted.
  const h = handle()
  await sql`
    INSERT INTO catalogue_requests (customer_handle, qty, description, status)
    VALUES (${h}, 1, 'Ordered before signing up', 'offer_pending')`

  const result = await approveAccessRequest(await queueRequest(h))

  const [row] = await sql<{ customer_id: number | null }[]>`
    SELECT customer_id FROM catalogue_requests
     WHERE customer_handle = ${h} ORDER BY id DESC LIMIT 1`
  assert.equal(row.customer_id, result.customerId)
})

test("claiming never steals a request already linked to someone else", async () => {
  const mine = handle()
  const [other] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${handle()}) RETURNING id`
  await sql`
    INSERT INTO catalogue_requests (customer_handle, customer_id, qty, description)
    VALUES (${mine}, ${other.id}, 1, 'Already linked elsewhere')`

  await approveAccessRequest(await queueRequest(mine))

  const [row] = await sql<{ customer_id: number }[]>`
    SELECT customer_id FROM catalogue_requests
     WHERE description = 'Already linked elsewhere'`
  assert.equal(row.customer_id, other.id, "an existing link must be left alone")
})

