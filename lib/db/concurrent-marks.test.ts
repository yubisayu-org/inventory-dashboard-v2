import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { markProductOutOfStock } from "./shopping-list"
import { getRefunds } from "./finance"

const TAG = `conc${process.hrtime.bigint()}`
const EV = `${TAG}_EV`
const WHO = `${TAG}_c`

// lydouble25's five, at her prices.
const ITEMS = [
  { name: `${TAG} PCM Cooling Towel`, price: 182000 },
  { name: `${TAG} Bottle Case`, price: 149000 },
  { name: `${TAG} Wire Tongs`, price: 144000 },
  { name: `${TAG} Bucket Hat`, price: 160000 },
  { name: `${TAG} Simple Cap`, price: 160000 },
]
const GOODS = ITEMS.reduce((n, i) => n + i.price, 0)   // 795_000
const productIds: number[] = []

before(async () => {
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
  for (const it of ITEMS) {
    const [p] = await sql<{ id: number }[]>`
      INSERT INTO products (name, gram, price) VALUES (${it.name}, 0, ${it.price}) RETURNING id`
    productIds.push(p.id)
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit)
      VALUES (${EV}, ${WHO}, ${p.id}, ${it.price}, 1)`
  }
  // Paid in full, so every rupiah of a reduction becomes surplus.
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${WHO}, ${GOODS}, true, 'deposit')`
})

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id LIKE ${`${TAG}%`})`
  await sql`DELETE FROM refunds WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("five products marked at once refund their own value, not each other's", async () => {
  // In production this happened in 120ms: five marks in flight, each pricing
  // its refund against an invoice the other four had already reduced. Five
  // refunds totalling Rp 3.473.000 against a surplus of Rp 795.000.
  await Promise.all(productIds.map((id) =>
    markProductOutOfStock({ event: EV, productId: id, quantityOutOfStock: 1 }, "tester")))

  const refunds = await getRefunds({ event: EV })
  const total = refunds.reduce((n, r) => n + Number(r.refundAmount), 0)

  assert.equal(refunds.length, ITEMS.length, "one refund per product")
  assert.equal(
    total, GOODS,
    `the five refunds must come to what the goods were worth, not to a multiple of it`,
  )

  // And each one is its own line, not the running total.
  const amounts = refunds.map((r) => Number(r.refundAmount)).sort((a, b) => a - b)
  assert.deepEqual(amounts, ITEMS.map((i) => i.price).sort((a, b) => a - b))
})
