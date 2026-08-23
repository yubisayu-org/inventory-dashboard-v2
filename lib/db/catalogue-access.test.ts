import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import {
  listPendingAccessRequests,
  approveAccessRequest,
  rejectAccessRequest,
  bulkInviteExistingCustomers,
  inviteByHandle,
  inviteUrl,
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
  await sql`DELETE FROM catalogue_requests WHERE customer_handle LIKE ${`${TAG}%`}`
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
     WHERE customer_handle = ${mine} ORDER BY id DESC LIMIT 1`
  assert.equal(row.customer_id, other.id, "an existing link must be left alone")
})


// An invite link must land on the catalogue, never on this dashboard. Reaching
// /customer/login directly skips the login nonce, and the sign-in that follows
// redeems the invite and THEN fails the exchange — spending the invite on an
// attempt that could never have completed.
test("an invite link points at the catalogue site, not the dashboard", () => {
  const url = inviteUrl("tok-123")
  assert.ok(
    url.startsWith(`${process.env.CATALOGUE_SITE_URL}/?invite=`),
    `expected a catalogue URL, got ${url}`,
  )
  assert.ok(!url.includes("/customer/login"), "must not jump straight to the dashboard")
})

test("an invite token is escaped into the link", () => {
  assert.ok(inviteUrl("a b&c=d").endsWith("?invite=a%20b%26c%3Dd"))
})

// ── inviting one person by handle ───────────────────────────────────────────
// The customers list only shows people with catalogue history, so before this
// the only way in for a stranger was a request they raised themselves.

test("inviting a handle that already has a customer issues without creating another", async () => {
  const h = handle()
  const [existing] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${h}) RETURNING id
  `
  const result = await inviteByHandle(h, { create: false })
  assert.equal(result.created, false)
  assert.equal(result.customerId, existing.id)

  const [{ count }] = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count FROM customers WHERE instagram_id = ${h}
  `
  assert.equal(Number(count), 1)
})

test("an unknown handle without create is refused, and no customer is left behind", async () => {
  const h = handle()
  await assert.rejects(
    () => inviteByHandle(h, { create: false }),
    (err: Error) => err.message === "no_customer",
  )

  const [{ count }] = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count FROM customers WHERE instagram_id = ${h}
  `
  assert.equal(Number(count), 0, "a refused invite must not mint a row from a typo")
})

test("an unknown handle with create makes exactly one customer and a redeemable invite", async () => {
  const h = handle()
  const result = await inviteByHandle(h, { create: true })
  assert.equal(result.created, true)
  assert.equal(result.instagramId, h)

  const [{ count }] = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count FROM customers WHERE instagram_id = ${h}
  `
  assert.equal(Number(count), 1)
  assert.deepEqual(await redeemInvite(result.token, `${TAG}_sub_by_handle_${n}`), {
    customerId: result.customerId,
  })
})

test("the @ and the capitals are noise — one customer, not two", async () => {
  const h = handle()
  const [existing] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${h}) RETURNING id
  `
  const result = await inviteByHandle(`@${h.toUpperCase()}`, { create: true })
  assert.equal(result.customerId, existing.id, "must match the row that is already there")
  assert.equal(result.created, false)
})

test("inviting again supersedes the link sent before it", async () => {
  const h = handle()
  const first = await inviteByHandle(h, { create: true })
  const second = await inviteByHandle(h, { create: false })
  assert.notEqual(first.token, second.token)

  // redeemInvite reports a dead token, it does not throw for one.
  assert.deepEqual(
    await redeemInvite(first.token, `${TAG}_sub_super_${n}`),
    { error: "expired" },
    "the superseded link must stop working",
  )
  assert.deepEqual(await redeemInvite(second.token, `${TAG}_sub_super2_${n}`), {
    customerId: second.customerId,
  })
})

test("inviting by handle claims the requests that handle placed before it had a row", async () => {
  const h = handle()
  await sql`
    INSERT INTO catalogue_requests (customer_handle, qty, description)
    VALUES (${h}, 1, 'Ordered before she was invited')
  `
  const result = await inviteByHandle(h, { create: true })

  const [{ count }] = await sql<{ count: string }[]>`
    SELECT COUNT(*) AS count FROM catalogue_requests
     WHERE customer_handle = ${h} AND customer_id = ${result.customerId}
  `
  assert.equal(Number(count), 1, "otherwise they sign in to an empty history")
})
