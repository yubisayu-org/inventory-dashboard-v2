import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"

const TAG = `livebal${process.hrtime.bigint()}`
const EV = `${TAG}_EV`
const WHO = `@${TAG}_Mixed`          // typed with an @ and capitals, on purpose
const KEY = `${TAG.toLowerCase()}_mixed`
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
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`%${TAG}%`}`
  await sql.end()
})

test("the view keys on the normalized handle, not the typed one", async () => {
  // "@Fandrianr" and "fandrianr" are one person. An exact join matches neither
  // reliably, and the failure is silent: every balance looks like zero.
  const [row] = await sql<{ customer: string; invoice_total: number; total_paid: number; balance: number }[]>`
    SELECT customer, invoice_total, total_paid, balance
      FROM live_balances WHERE event = ${EV}`
  assert.equal(row.customer, KEY)
  assert.equal(row.invoice_total, 300000, "3 × 100.000, no ongkir on a zero-gram product")
  assert.equal(row.total_paid, 500000)
  assert.equal(row.balance, 200000, "positive means she has overpaid")
})

test("the balance follows the orders", async () => {
  await sql`UPDATE orders SET unit = 5 WHERE event = ${EV}`
  const [row] = await sql<{ balance: number }[]>`
    SELECT balance FROM live_balances WHERE event = ${EV}`
  assert.equal(row.balance, 0, "500.000 paid against 500.000 ordered")
})

test("unchecked payments do not count", async () => {
  // Same rule as getPaymentStatus: money is money when somebody has confirmed it.
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${WHO}, 900000, false, 'deposit')`
  const [row] = await sql<{ balance: number }[]>`
    SELECT balance FROM live_balances WHERE event = ${EV}`
  assert.equal(row.balance, 0)
})
