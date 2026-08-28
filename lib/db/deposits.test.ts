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
