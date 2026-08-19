import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import {
  hashToken,
  issueInvite,
  redeemInvite,
  issueSession,
  resolveSession,
  revokeSession,
  revokeCustomer,
  signInByGoogleSub,
} from "./catalogue-auth"

const TAG = `authtest${process.hrtime.bigint()}`
let n = 0

async function makeCustomer(): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${`${TAG}_${n++}`}) RETURNING id
  `
  return row.id
}

after(async () => {
  // Cascades to invites and sessions.
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("the plaintext token is never stored", async () => {
  const id = await makeCustomer()
  const token = await issueInvite(id)
  const rows = await sql<{ token_hash: string }[]>`
    SELECT token_hash FROM customer_invites WHERE customer_id = ${id}
  `
  assert.equal(rows[0].token_hash, hashToken(token))
  assert.notEqual(rows[0].token_hash, token)
})

test("redeeming binds the google account and marks the invite used", async () => {
  const id = await makeCustomer()
  const token = await issueInvite(id)
  assert.deepEqual(await redeemInvite(token, `${TAG}_sub_a`), { customerId: id })

  const [c] = await sql<{ google_sub: string; catalogue_access: string; bound_at: Date }[]>`
    SELECT google_sub, catalogue_access, bound_at FROM customers WHERE id = ${id}
  `
  assert.equal(c.google_sub, `${TAG}_sub_a`)
  assert.equal(c.catalogue_access, "active")
  assert.ok(c.bound_at)
})

test("an invite cannot be redeemed twice", async () => {
  const id = await makeCustomer()
  const token = await issueInvite(id)
  await redeemInvite(token, `${TAG}_sub_b`)
  assert.deepEqual(await redeemInvite(token, `${TAG}_sub_c`), { error: "used" })
})

test("re-issuing supersedes the earlier invite", async () => {
  const id = await makeCustomer()
  const first = await issueInvite(id)
  await issueInvite(id)
  assert.deepEqual(await redeemInvite(first, `${TAG}_sub_d`), { error: "expired" })
})

test("an expired invite is refused", async () => {
  const id = await makeCustomer()
  const token = await issueInvite(id, -1)
  assert.deepEqual(await redeemInvite(token, `${TAG}_sub_e`), { error: "expired" })
})

test("an unknown token is refused", async () => {
  assert.deepEqual(await redeemInvite("not-a-real-token", `${TAG}_sub_f`), { error: "invalid" })
})

test("a google account already bound elsewhere cannot be rebound", async () => {
  const a = await makeCustomer()
  const b = await makeCustomer()
  await redeemInvite(await issueInvite(a), `${TAG}_sub_g`)
  assert.deepEqual(
    await redeemInvite(await issueInvite(b), `${TAG}_sub_g`),
    { error: "sub_taken" },
  )
})

test("a returning customer signs in on their google sub alone", async () => {
  const id = await makeCustomer()
  await redeemInvite(await issueInvite(id), `${TAG}_sub_h`)
  assert.deepEqual(await signInByGoogleSub(`${TAG}_sub_h`), { customerId: id })
  assert.equal(await signInByGoogleSub(`${TAG}_sub_nobody`), null)
})

test("a session resolves, then stops resolving once revoked", async () => {
  const id = await makeCustomer()
  await redeemInvite(await issueInvite(id), `${TAG}_sub_i`)
  const token = await issueSession(id)
  assert.equal((await resolveSession(token))?.id, id)
  await revokeSession(token)
  assert.equal(await resolveSession(token), null)
})

test("revoking a customer kills their live sessions immediately", async () => {
  const id = await makeCustomer()
  await redeemInvite(await issueInvite(id), `${TAG}_sub_j`)
  const token = await issueSession(id)
  assert.ok(await resolveSession(token))
  await revokeCustomer(id)
  assert.equal(await resolveSession(token), null)
})

test("a session for a customer who was never activated does not resolve", async () => {
  // catalogue_access defaults to 'none'; only redemption sets it active.
  const id = await makeCustomer()
  const token = await issueSession(id)
  assert.equal(await resolveSession(token), null)
})
