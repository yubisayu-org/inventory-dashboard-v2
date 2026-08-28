import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { applyRefundAsCredit } from "./finance"

const TAG = `livecred${process.hrtime.bigint()}`
const EV = `${TAG}_EV`
const NEXT = `${TAG}_NEXT`
const WHO = `${TAG}_c`
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (name, gram, price) VALUES (${`${TAG} thing`}, 0, 100000) RETURNING id`
  productId = p.id
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
  for (const e of [EV, NEXT]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit)
      VALUES (${e}, ${WHO}, ${productId}, 100000, 3)`
  }
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${WHO}, 500000, true, 'deposit')`
})

after(async () => {
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM refunds WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("you cannot move more credit than she is actually owed", async () => {
  // The row says 200.000; she has since ordered more and is owed 100.000.
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'overpayment', 200000, 'pending') RETURNING id`
  await sql`UPDATE orders SET unit = 4 WHERE event = ${EV}`

  await assert.rejects(
    () => applyRefundAsCredit(r.id, NEXT, 200000, "tester"),
    /exceeds/i,
    "the stored figure is not a licence to move money that is not there",
  )

  await applyRefundAsCredit(r.id, NEXT, 100000, "tester")
  const [row] = await sql<{ refund_amount: number; status: string }[]>`
    SELECT refund_amount::int AS refund_amount, status FROM refunds WHERE id = ${r.id}`
  assert.equal(row.refund_amount, 0)
  assert.equal(row.status, "applied_to_next_order")
  await sql`UPDATE orders SET unit = 3 WHERE event = ${EV}`
})
