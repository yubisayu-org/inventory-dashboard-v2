import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { recordChargedWeight } from "./parcel-plan"

const TAG = "planweigh"
const EVENT = `${TAG}_EV`
const WHO = `${TAG}_c`
let customerId = 0
let shipmentId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price)
    VALUES (${`${TAG} item`}, ${TAG}, 500, 0) RETURNING id`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${WHO}) RETURNING id`
  customerId = c.id
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive)
    VALUES (${EVENT}, ${WHO}, ${p.id}, 100000, 4, 4, 4, 4)`
  // The parcel as it left: estimated 2 kg, billed at Rp 25.000/kg.
  const [s] = await sql<{ id: number }[]>`
    INSERT INTO shipments (event, customer, shipping_id, invoicing, weight_estimation, ongkir, ongkir_total, is_last_shipment)
    VALUES (${EVENT}, ${WHO}, '1', '', 2, 25000, 50000, true) RETURNING id`
  shipmentId = s.id
  // A split fee already on the books, to prove the difference lands beside it
  // rather than on top of it.
  await sql`
    INSERT INTO adjustments (event, customer, description, amount, auto)
    VALUES (${EVENT}, ${WHO}, 'Ongkir kirim duluan', 25000, true)`
})

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM adjustments WHERE event = ${EVENT}`
  await sql`DELETE FROM shipments WHERE event = ${EVENT}`
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id = ${WHO}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql.end()
})

async function rows() {
  const r = (await sql`
    SELECT description, amount::int AS amount FROM adjustments
     WHERE event = ${EVENT} AND auto ORDER BY id`) as unknown as
    { description: string; amount: number }[]
  return r.map((x) => ({ description: x.description, amount: x.amount }))
}

test("a heavier parcel bills the difference as its own row", async () => {
  // Its own row, not an edit to the split fee: what splitting cost and what
  // the estimate missed are different facts, and one number could not say
  // which had moved.
  await recordChargedWeight(shipmentId, 3)
  assert.deepEqual(await rows(), [
    { description: "Ongkir kirim duluan", amount: 25000 },
    { description: "Selisih ongkir JNE (2 kg → 3 kg)", amount: 25000 },
  ])
})

test("she is told, and told why", async () => {
  const [n] = (await sql`
    SELECT title, body FROM announcements
     WHERE customer_id = ${customerId} ORDER BY id DESC LIMIT 1`) as unknown as
    { title: string; body: string }[]
  assert.match(n.body, /3 kg oleh kurir/)
  assert.match(n.body, /estimasi kami 2 kg/)
  assert.doesNotMatch(`${n.title} ${n.body}`, /\{\w+\}/)
})

test("correcting it again re-prices rather than stacking", async () => {
  await recordChargedWeight(shipmentId, 4)
  assert.deepEqual(await rows(), [
    { description: "Ongkir kirim duluan", amount: 25000 },
    { description: "Selisih ongkir JNE (2 kg → 4 kg)", amount: 50000 },
  ])
})

test("correcting it back to the estimate removes the difference", async () => {
  await recordChargedWeight(shipmentId, null)
  assert.deepEqual(await rows(), [{ description: "Ongkir kirim duluan", amount: 25000 }])
  const [s] = (await sql`
    SELECT weight_charged FROM shipments WHERE id = ${shipmentId}`) as unknown as
    { weight_charged: number | null }[]
  assert.equal(s.weight_charged, null)
})

test("a charged weight equal to the estimate is not a correction", async () => {
  // Recording 2 when the estimate said 2 earns nothing and must write nothing.
  await recordChargedWeight(shipmentId, 2)
  assert.deepEqual(await rows(), [{ description: "Ongkir kirim duluan", amount: 25000 }])
})
