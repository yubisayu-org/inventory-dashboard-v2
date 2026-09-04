import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { shipCustomerOrders } from "./fulfillment"

// Delivery given away. It is charged as usual and credited in full, rather
// than not charged at all — a missing line reads exactly like a rate nobody
// recorded, and seven parcels are already sitting in that state.

const TAG = `freeship${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const RATE = 13_000

let customerId = 0
let handle = ""
let orderId = 0
let productId = 0

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM adjustments WHERE event = ${EVENT}`
  await sql`DELETE FROM shipments WHERE event = ${EVENT}`
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ${customerId}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql.end()
})

async function seed() {
  handle = `${TAG}_cust`
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${handle}) RETURNING id`
  customerId = c.id

  const [w] = await sql<{ id: number }[]>`SELECT id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO events (name, warehouse_id) VALUES (${EVENT}, ${w.id})`
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
    VALUES (${customerId}, ${w.id}, ${RATE})`

  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price) VALUES (${`${TAG} item`}, ${TAG}, 400, 0)
    RETURNING id`
  productId = p.id
  const [o] = await sql<{ id: number }[]>`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_arrive)
    VALUES (${EVENT}, ${handle}, ${productId}, 200000, 1, 1, 1)
    RETURNING id`
  orderId = o.id
}

test("a gifted delivery is charged and then credited, not left off", async () => {
  await seed()
  await shipCustomerOrders({
    customer: handle,
    event: EVENT,
    orders: [{ rowNumber: orderId, productId, productName: `${TAG} item`, toShip: 1, unitShip: 0 }],
    weightKg: 0.4,
    ongkirPerKg: RATE,
    freeShipping: true,
  })

  // The parcel still records what the delivery was worth: the shop paid for
  // it, and a report of what shipping costs should not lose a box because it
  // was given away.
  const [ship] = await sql<{ ongkir: number; ongkir_total: number }[]>`
    SELECT ongkir, ongkir_total FROM shipments WHERE event = ${EVENT}`
  assert.equal(ship.ongkir, RATE)
  assert.equal(ship.ongkir_total, RATE, "one kilo, charged")

  const [credit] = await sql<{ description: string; amount: number; auto: boolean }[]>`
    SELECT description, amount, auto FROM adjustments WHERE event = ${EVENT}`
  assert.ok(credit, "and a credit of the same size")
  assert.equal(credit.amount, -RATE)
  assert.match(credit.description, /Gratis ongkir/)
  assert.equal(credit.auto, true)

  // She is told, in the same words a merged-parcel discount uses. Not the
  // newest message — the parcel's own "on its way" lands after it.
  const notices = await sql<{ title: string }[]>`
    SELECT title FROM announcements WHERE customer_id = ${customerId}`
  assert.ok(notices.some((n) => /Diskon ongkir/.test(n.title)), "she hears about the gift")
})

test("without the tick nothing is credited", async () => {
  await sql`DELETE FROM adjustments WHERE event = ${EVENT}`
  await sql`DELETE FROM shipments WHERE event = ${EVENT}`
  await sql`UPDATE orders SET unit_ship = 0 WHERE id = ${orderId}`

  await shipCustomerOrders({
    customer: handle,
    event: EVENT,
    orders: [{ rowNumber: orderId, productId, productName: `${TAG} item`, toShip: 1, unitShip: 0 }],
    weightKg: 0.4,
    ongkirPerKg: RATE,
  })

  const rows = await sql`
    SELECT id FROM adjustments WHERE event = ${EVENT} AND description LIKE 'Gratis ongkir%'`
  assert.equal(rows.length, 0)
})
