import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { refundForReduction } from "./mark-refunds"
import { getRefunds } from "./finance"

const TAG = `marktest${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const PAID = `${TAG}_paid`
const UNPAID = `${TAG}_unpaid`
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products WHERE COALESCE(gram,0) = 0 ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  for (const who of [PAID, UNPAID]) {
    await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit)
      VALUES (${EVENT}, ${who}, ${productId}, 100000, 1)`
  }
  // Only one of them has transferred anything.
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EVENT}, ${PAID}, 100000, true, 'deposit')`
})

after(async () => {
  // announcements is keyed by customer_id, not by event.
  await sql`DELETE FROM announcements WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id LIKE ${`${TAG}%`})`
  await sql`DELETE FROM refunds WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM excess_purchase WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("only the customer who paid is refunded", async () => {
  // Both orders shrink to zero. The unpaid one simply owes less.
  await sql`UPDATE orders SET unit = 0 WHERE event = ${EVENT}`
  const made = await refundForReduction(EVENT, "unavailable", "Test Product", [
    { customer: PAID, unitsRemoved: 1, unitPrice: 100000 },
    { customer: UNPAID, unitsRemoved: 1, unitPrice: 100000 },
  ], "tester")

  assert.equal(made.length, 1, "one refund, not two")
  assert.equal(made[0].amount, 100000)

  const rows = await getRefunds({ event: EVENT })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].reason, "unavailable")
  assert.equal(rows[0].status, "pending")
})

test("the customer is told, in the same breath", async () => {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM announcements
     WHERE customer_id IN (SELECT id FROM customers WHERE instagram_id = ${PAID})`
  assert.ok(Number(rows[0].n) >= 1, "a refund nobody is told about is a promise nobody made")
})
