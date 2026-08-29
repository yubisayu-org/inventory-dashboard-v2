import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { reconcileParcelPlan } from "./parcel-plan"

// hanapanjaitan's shape, from production. 1.390 g on one trip and 100 g on
// another: invoiced as 2 kg + 1 kg, but one box weighs 1.490 g and the courier
// bills 2 kg. One kilo saved, Rp 14.000 — once.
const TAG = `mergeonce${process.hrtime.bigint()}`
const A = `${TAG}_AEV`
const B = `${TAG}_BEV`
const C = `${TAG}_CEV`
const WHO = `${TAG}_c`
const RATE = 14_000
let customerId = 0
let bigId = 0
let smallId = 0

async function adjustments() {
  return await sql<{ event: string; amount: number; description: string }[]>`
    SELECT event, amount::int AS amount, description FROM adjustments
     WHERE customer = ${WHO} AND auto ORDER BY event`
}

before(async () => {
  const [big] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price) VALUES (${`${TAG} big`}, ${TAG}, 1390, 0) RETURNING id`
  const [small] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price) VALUES (${`${TAG} small`}, ${TAG}, 100, 0) RETURNING id`
  bigId = big.id
  smallId = small.id
  for (const e of [A, B, C]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
  }
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${WHO}) RETURNING id`
  customerId = c.id
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
    SELECT ${c.id}, id, ${RATE} FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy)
    VALUES (${A}, ${WHO}, ${bigId}, 100000, 1, 1)`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy)
    VALUES (${B}, ${WHO}, ${smallId}, 100000, 1, 1)`
})

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM adjustments WHERE customer = ${WHO}`
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ${customerId}`
  await sql`DELETE FROM orders WHERE customer = ${WHO}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id = ${WHO}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql.end()
})

async function pair(events: string[]) {
  const key = `${TAG}-grp`
  for (const e of events) {
    await sql`
      INSERT INTO customer_shipping_prefs (customer_id, event, mode, set_by, merge_key)
      VALUES (${customerId}, ${e}, 'wait', 'customer', ${key})
      ON CONFLICT (customer_id, event) DO UPDATE SET merge_key = ${key}`
  }
}

test("a two-trip merge is credited once, not once per trip", async () => {
  // 2 kg + 1 kg invoiced, one 1.490 g box billed as 2 kg. The saving is one
  // kilo. Written on both trips it was two.
  await pair([A, B])
  for (const e of [A, B]) await reconcileParcelPlan(WHO, e)

  const rows = await adjustments()
  assert.equal(rows.length, 1, "one credit for one saving")
  assert.equal(rows[0].event, A, "held by the first trip of the group, by name")
  assert.equal(rows[0].amount, -RATE)
  assert.match(rows[0].description, new RegExp(B), "and it says which trip it merged with")
})

test("reconciling the other trip does not add a second", async () => {
  // Every arrival on either trip runs this. It must stay at one however often
  // it is asked.
  for (const e of [B, A, B]) await reconcileParcelPlan(WHO, e)
  assert.equal((await adjustments()).length, 1)
})

test("a duplicate already on the books is cleared", async () => {
  // The production repair path: hanapanjaitan carries one of these on each
  // trip. Reconciling the trip that should not hold it deletes it.
  await sql`
    INSERT INTO adjustments (event, customer, description, amount, auto)
    VALUES (${B}, ${WHO}, ${`Gabung ongkir dengan ${A}`}, ${-RATE}, true)`
  assert.equal((await adjustments()).length, 2, "planted")

  await reconcileParcelPlan(WHO, B)
  const rows = await adjustments()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event, A)
})

test("a three-trip merge is still one credit", async () => {
  // Where the old shape paid three times.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy)
    VALUES (${C}, ${WHO}, ${smallId}, 100000, 1, 1)`
  await pair([A, B, C])
  for (const e of [A, B, C]) await reconcileParcelPlan(WHO, e)

  const rows = await adjustments()
  assert.equal(rows.length, 1, "one credit")
  assert.equal(rows[0].event, A)
  // 2 + 1 + 1 invoiced = 4 kg; one box of 1.590 g = 2 kg. Two kilos saved.
  assert.equal(rows[0].amount, -2 * RATE)
})

test("unpairing takes the credit away with it", async () => {
  await sql`
    UPDATE customer_shipping_prefs SET merge_key = NULL WHERE customer_id = ${customerId}`
  for (const e of [A, B, C]) await reconcileParcelPlan(WHO, e)
  assert.equal((await adjustments()).length, 0)
})
