import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { executeRefund } from "./finance"

const TAG = `liveexec${process.hrtime.bigint()}`
const EV = `${TAG}_EV`
const WHO = `${TAG}_c`
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (name, gram, price) VALUES (${`${TAG} thing`}, 0, 100000) RETURNING id`
  productId = p.id
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EV}, ${WHO}, ${productId}, 100000, 3)`
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

test("the transfer is for what she is owed at that moment, and freezes there", async () => {
  // Written when she was owed 200.000; by the time it is paid she has ordered
  // more and is owed 100.000. The transfer must be the smaller figure.
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'overpayment', 200000, 'ready_to_refund') RETURNING id`
  await sql`UPDATE orders SET unit = 4 WHERE event = ${EV}`

  await executeRefund(r.id, `${TAG}-ref`, "BCA", "tester")

  const [row] = await sql<{ refund_amount: number; status: string }[]>`
    SELECT refund_amount::int AS refund_amount, status FROM refunds WHERE id = ${r.id}`
  assert.equal(row.refund_amount, 100000, "frozen at what was actually paid")
  assert.equal(row.status, "refunded")

  const [pay] = await sql<{ amount: number }[]>`
    SELECT amount::int AS amount FROM payments WHERE refund_id = ${r.id} AND kind = 'refund'`
  assert.equal(pay.amount, -100000, "money out, at the same figure")

  await sql`UPDATE orders SET unit = 3 WHERE event = ${EV}`
})

test("a goods refund pays exactly what it says", async () => {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'unavailable', 160000, 'ready_to_refund') RETURNING id`
  await executeRefund(r.id, `${TAG}-ref2`, "BCA", "tester")
  const [pay] = await sql<{ amount: number }[]>`
    SELECT amount::int AS amount FROM payments WHERE refund_id = ${r.id} AND kind = 'refund'`
  assert.equal(pay.amount, -160000)
})

test("nothing owed cannot be paid out", async () => {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'overpayment', 200000, 'ready_to_refund') RETURNING id`
  await sql`UPDATE orders SET unit = 9 WHERE event = ${EV}`   // she owes money now
  await assert.rejects(() => executeRefund(r.id, `${TAG}-ref3`, "BCA", "tester"), /nothing/i)
  await sql`UPDATE orders SET unit = 3 WHERE event = ${EV}`
})
