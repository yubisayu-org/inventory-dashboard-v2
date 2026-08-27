import { test } from "node:test"
import assert from "node:assert/strict"
import { strandedBoughtUnits } from "./orders"

test("bought units above what is ordered are on nobody's order", () => {
  // Ordered 3, bought 4 by mistake at the hotel. The fourth exists and is
  // attached to nothing.
  assert.equal(strandedBoughtUnits(3, 4), 1)
})

test("shrinking an order strands what was already bought for it", () => {
  // Ordered 3, bought 3, she now wants 2.
  assert.equal(strandedBoughtUnits(2, 3), 1)
})

test("buying less than ordered strands nothing — it is simply unfinished", () => {
  assert.equal(strandedBoughtUnits(3, 1), 0)
})

test("nothing bought strands nothing", () => {
  assert.equal(strandedBoughtUnits(3, 0), 0)
})

test("exactly bought strands nothing", () => {
  assert.equal(strandedBoughtUnits(3, 3), 0)
})

// ─── Against the database ────────────────────────────────────────────────────

import { before, after } from "node:test"
import sql from "../db-pool"
import { bankStrandedBoughtUnits } from "./orders"

const TAG = "stranded"
const EVENT = `${TAG}_EV`
const WHO = `${TAG}_c`
let orderId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price)
    VALUES (${`${TAG} item`}, ${TAG}, 500, 0) RETURNING id`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
  // Ordered 3, bought 4 at the hotel by mistake.
  const [o] = await sql<{ id: number }[]>`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, receipt)
    VALUES (${EVENT}, ${WHO}, ${p.id}, 100000, 3, 4, 'R-1') RETURNING id`
  orderId = o.id
})

after(async () => {
  await sql`DELETE FROM excess_purchase WHERE event = ${EVENT}`
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id = ${WHO}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql.end()
})

test("the surplus goes to the shelf, and the order stops claiming it", async () => {
  const { banked } = await bankStrandedBoughtUnits(orderId)
  assert.equal(banked, 1)

  const [o] = (await sql`SELECT unit, unit_buy FROM orders WHERE id = ${orderId}`) as unknown as
    { unit: number; unit_buy: number }[]
  assert.equal(o.unit, 3, "she keeps what she ordered")
  assert.equal(o.unit_buy, 3, "the order no longer claims the fourth")

  const [x] = (await sql`
    SELECT items, unit_buy::int AS unit_buy, receipt FROM excess_purchase WHERE event = ${EVENT}`) as unknown as
    { items: string; unit_buy: number; receipt: string }[]
  assert.equal(x.unit_buy, 1)
  assert.equal(x.receipt, "R-1", "the shelf row traces back to the purchase")
})

test("running it again banks nothing", async () => {
  // Idempotent, because it reads the state rather than remembering an event.
  const { banked } = await bankStrandedBoughtUnits(orderId)
  assert.equal(banked, 0)
  const [{ n }] = (await sql`
    SELECT count(*)::int AS n FROM excess_purchase WHERE event = ${EVENT}`) as unknown as { n: number }[]
  assert.equal(n, 1)
})
