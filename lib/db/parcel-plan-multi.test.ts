import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { reconcileParcelPlan } from "./parcel-plan"

// Three items, 500 g each. 1.5 kg, so the invoice charges 2 kg of ongkir.
// Sent one at a time, the courier bills 1 kg a box — 3 kg in all. She owes the
// difference, once, however many boxes it took.
const TAG = "multisplit"
const EVENT = `${TAG}_EV`
const WHO = `${TAG}_c`
const RATE = 25_000
let customerId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price)
    VALUES (${`${TAG} item`}, ${TAG}, 500, 0) RETURNING id`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${WHO}) RETURNING id`
  customerId = c.id
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
    SELECT ${c.id}, id, ${RATE} FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive)
    VALUES (${EVENT}, ${WHO}, ${p.id}, 100000, 3, 3, 3, 1)`
  await sql`
    INSERT INTO customer_shipping_prefs (customer_id, event, mode, set_by)
    VALUES (${customerId}, ${EVENT}, 'split', 'shop')`
})

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM adjustments WHERE event = ${EVENT}`
  await sql`DELETE FROM shipments WHERE event = ${EVENT}`
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ${customerId}`
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id = ${WHO}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql.end()
})

async function fee(): Promise<number> {
  const [r] = (await sql`
    SELECT amount::int AS amount FROM adjustments WHERE event = ${EVENT} AND auto`) as unknown as
    { amount: number }[]
  return r?.amount ?? 0
}

/** One item leaves: the courier bills a whole kilo for it. */
async function sendOne(n: number) {
  await sql`UPDATE orders SET unit_ship = ${n} WHERE event = ${EVENT}`
  await sql`
    INSERT INTO shipments (event, customer, shipping_id, invoicing, weight_estimation, ongkir, ongkir_total, is_last_shipment)
    VALUES (${EVENT}, ${WHO}, ${String(n)}, '', 1, ${RATE}, ${RATE}, true)`
  await reconcileParcelPlan(WHO, EVENT)
}

test("the first box is free — two parcels still fit the two kilos she paid", async () => {
  await reconcileParcelPlan(WHO, EVENT)
  assert.equal(await fee(), 0)
})

test("the second box is where she starts owing", async () => {
  await sendOne(1)                                   // box 1 gone, 1 kg billed
  await sql`UPDATE orders SET unit_arrive = 2 WHERE event = ${EVENT}`
  await reconcileParcelPlan(WHO, EVENT)
  // 1 sent + 1 going + 1 to follow = 3 kg against 2 invoiced.
  assert.equal(await fee(), RATE)
})

test("the third box does not charge her again", async () => {
  await sendOne(2)                                   // box 2 gone
  await sql`UPDATE orders SET unit_arrive = 3 WHERE event = ${EVENT}`
  await reconcileParcelPlan(WHO, EVENT)
  assert.equal(await fee(), RATE, "three boxes were always going to be three kilos")
  await sendOne(3)                                   // box 3 gone
  assert.equal(await fee(), RATE)
})

test("what she paid matches what the courier was paid", async () => {
  const [{ kg }] = (await sql`
    SELECT COALESCE(SUM(weight_estimation), 0)::int AS kg FROM shipments WHERE event = ${EVENT}
  `) as unknown as { kg: number }[]
  assert.equal(kg, 3, "three boxes, a kilo each")
  assert.equal(2 * RATE + (await fee()), kg * RATE, "invoice covered 2 kg, the fee covers the third")
})
