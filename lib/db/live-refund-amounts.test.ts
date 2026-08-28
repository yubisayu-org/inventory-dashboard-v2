import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getRefunds } from "./finance"

const TAG = `liveamt${process.hrtime.bigint()}`
const EV = `${TAG}_EV`
const WHO = `${TAG}_c`
let productId = 0

const amountOf = async (id: number) =>
  (await getRefunds({ event: EV })).find((r) => r.id === id)?.refundAmount

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
  await sql`DELETE FROM refunds WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("an open overpayment shows what she is owed now, not when it was written", async () => {
  // She has paid 500.000 against 300.000 of orders: 200.000 overpaid.
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'overpayment', 200000, 'pending') RETURNING id`
  assert.equal(await amountOf(r.id), 200000)

  // She orders two more. Nothing touches the refund row.
  await sql`UPDATE orders SET unit = 5 WHERE event = ${EV}`
  assert.equal(await amountOf(r.id), 0, "the overpayment is gone, and so is the refund's amount")

  await sql`UPDATE orders SET unit = 4 WHERE event = ${EV}`
  assert.equal(await amountOf(r.id), 100000)
  await sql`UPDATE orders SET unit = 3 WHERE event = ${EV}`
  await sql`DELETE FROM refunds WHERE id = ${r.id}`
})

test("she can never be owed a negative amount", async () => {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'overpayment', 200000, 'pending') RETURNING id`
  await sql`UPDATE orders SET unit = 9 WHERE event = ${EV}`   // she now owes 400.000
  assert.equal(await amountOf(r.id), 0, "owing money is not a negative refund")
  await sql`UPDATE orders SET unit = 3 WHERE event = ${EV}`
  await sql`DELETE FROM refunds WHERE id = ${r.id}`
})

test("a goods refund keeps its stored price", async () => {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'unavailable', 160000, 'pending') RETURNING id`
  await sql`UPDATE orders SET unit = 5 WHERE event = ${EV}`
  assert.equal(await amountOf(r.id), 160000, "the item cost what it cost")
  await sql`UPDATE orders SET unit = 3 WHERE event = ${EV}`
  await sql`DELETE FROM refunds WHERE id = ${r.id}`
})

test("a deposit keeps its stored figure", async () => {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EV}, ${WHO}, 'overpayment', 200000, 'applied_to_next_order') RETURNING id`
  await sql`UPDATE orders SET unit = 5 WHERE event = ${EV}`
  assert.equal(await amountOf(r.id), 200000, "she chose to keep this; it is hers")
  await sql`UPDATE orders SET unit = 3 WHERE event = ${EV}`
  await sql`DELETE FROM refunds WHERE id = ${r.id}`
})
