import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { heldDeposits } from "./deposits"
import { applyRefundAsCredit } from "./finance"

const TAG = `deposit${process.hrtime.bigint()}`
const OLD = `${TAG}_OLD`
const NEXT = `${TAG}_NEXT`
const WHO = `${TAG}_c`
let productId = 0
let refundId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
  for (const e of [OLD, NEXT]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit)
      VALUES (${e}, ${WHO}, ${productId}, 500000, 1)`
  }
  // She overpaid the old trip and chose to keep it on her account: filed, with
  // the money still on it and no payment written.
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${OLD}, ${WHO}, 'overpayment', 209400, 'applied_to_next_order') RETURNING id`
  refundId = r.id
})

after(async () => {
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM refunds WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("a promised credit is found, so the next invoice can offer it", async () => {
  const held = await heldDeposits(WHO)
  assert.equal(held.length, 1)
  assert.equal(held[0].amount, 209400)
  assert.equal(held[0].fromEvent, OLD, "and says which trip it came from")
})

test("the handle is matched however it was typed", async () => {
  assert.equal((await heldDeposits(`@${WHO.toUpperCase()}`)).length, 1)
})

test("once applied it stops being offered", async () => {
  // The money has moved onto the next trip: a settled credit, not a promise.
  await applyRefundAsCredit(refundId, NEXT, 209400, "tester")
  assert.deepEqual(await heldDeposits(WHO), [], "nothing left to offer")
})

test("a refund nobody promised as credit is not a deposit", async () => {
  // Pending cash refunds are money owed, but not money she is holding for a
  // future order -- the banner would be inventing an offer.
  await sql`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${OLD}, ${WHO}, 'overpayment', 50000, 'pending')`
  assert.deepEqual(await heldDeposits(WHO), [])
})

test("spending part of a deposit leaves the rest a deposit", async () => {
  // She holds Rp 2.000 and owes Rp 1.000. Taking what is needed must not turn
  // the leftover back into a plain pending refund -- the banner and the list
  // marker both look for deposits, so the remainder would go quiet exactly
  // when it got small enough to forget.
  const EV3 = `${TAG}_THIRD`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV3}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EV3}, ${WHO}, ${productId}, 500000, 1)`
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${OLD}, ${WHO}, 'overpayment', 2000, 'applied_to_next_order') RETURNING id`

  await applyRefundAsCredit(r.id, EV3, 1000, "tester")

  const [row] = await sql<{ status: string; refund_amount: number }[]>`
    SELECT status, refund_amount::int AS refund_amount FROM refunds WHERE id = ${r.id}`
  assert.equal(row.refund_amount, 1000, "the unspent part is still owed")
  assert.equal(row.status, "applied_to_next_order", "and is still a deposit")

  const held = await heldDeposits(WHO)
  assert.equal(held.length, 1, "so the next invoice still offers it")
  assert.equal(held[0].amount, 1000)
})

test("a plain pending refund still goes back to pending when part-applied", async () => {
  // Unchanged for the case the old behaviour was written for: a claim that is
  // part settled is still a claim.
  //
  // A goods refund, deliberately: an overpayment's amount is read from her
  // balance now, so a fixture with no real overpayment has nothing to apply.
  // The rule under test is about status, not about where the figure comes from.
  //
  // Its own trip, because the database allows only one active overpayment
  // refund per customer per event.
  const EV4 = `${TAG}_FOURTH`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV4}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EV4}, ${WHO}, ${productId}, 500000, 1)`
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV4}, ${WHO}, 'unavailable', 5000, 'pending') RETURNING id`
  await applyRefundAsCredit(r.id, NEXT, 2000, "tester")
  const [row] = await sql<{ status: string }[]>`SELECT status FROM refunds WHERE id = ${r.id}`
  assert.equal(row.status, "pending")
})

test("several deposits are returned oldest first, so the lot spends in that order", async () => {
  // "Pakai semua" walks this list and stops when the invoice is covered. The
  // order is the whole behaviour: a credit sitting since June should go before
  // one from last week, or the old one never leaves her account.
  const WHO2 = `${TAG}_many`
  const A = `${TAG}_A`, B = `${TAG}_B`
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO2})`
  for (const e of [A, B]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit)
      VALUES (${e}, ${WHO2}, ${productId}, 500000, 1)`
  }
  // Written newest-first on purpose, with updated_at saying otherwise.
  await sql`
    INSERT INTO refunds (event, customer, reason, refund_amount, status, updated_at)
    VALUES (${B}, ${WHO2}, 'unavailable', 2000, 'applied_to_next_order', NOW())`
  await sql`
    INSERT INTO refunds (event, customer, reason, refund_amount, status, updated_at)
    VALUES (${A}, ${WHO2}, 'overpayment', 160000, 'applied_to_next_order', NOW() - INTERVAL '60 days')`

  const held = await heldDeposits(WHO2)
  assert.equal(held.length, 2)
  assert.equal(held[0].fromEvent, A, "the older one leads")
  assert.equal(held[1].fromEvent, B)
  assert.equal(held.reduce((n, d) => n + d.amount, 0), 162000)
})
