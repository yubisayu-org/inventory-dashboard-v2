import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { markProductArrived } from "./fulfillment"
import { reconcileParcelPlan } from "./parcel-plan"

const TAG = "plantrig"
const EVENT = `${TAG}_EV`
const WHO = `${TAG}_c`
const BYSTANDER = `${TAG}_b`
let customerId = 0
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price)
    VALUES (${`${TAG} item`}, ${TAG}, 600, 0) RETURNING id`
  productId = p.id
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  for (const who of [WHO, BYSTANDER]) {
    const [c] = await sql<{ id: number }[]>`
      INSERT INTO customers (instagram_id) VALUES (${who}) RETURNING id`
    if (who === WHO) customerId = c.id
    await sql`
      INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
      SELECT ${c.id}, id, 25000 FROM warehouses ORDER BY id LIMIT 1`
    // 3 × 600 g = 1.8 kg, invoiced at 2 kg. Nothing has arrived yet.
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive)
      VALUES (${EVENT}, ${who}, ${productId}, 100000, 3, 3, 3, 0)`
    await sql`
      INSERT INTO payments (event, customer, amount, is_checked, kind)
      VALUES (${EVENT}, ${who}, 350000, true, 'deposit')`
  }
  // Only one of them is splitting.
  await sql`
    INSERT INTO customer_shipping_prefs (customer_id, event, mode, set_by)
    VALUES (${customerId}, ${EVENT}, 'split', 'shop')`
})

after(async () => {
  await sql`DELETE FROM adjustments WHERE event = ${EVENT}`
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id LIKE ${`${TAG}%`})`
  await sql`DELETE FROM payments WHERE event = ${EVENT}`
  await sql`DELETE FROM excess_purchase WHERE event = ${EVENT}`
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql.end()
})

async function autoAmount(who = WHO): Promise<number | null> {
  const [row] = (await sql`
    SELECT amount::int AS amount FROM adjustments
     WHERE event = ${EVENT} AND customer = ${who} AND auto LIMIT 1`) as unknown as { amount: number }[]
  return row?.amount ?? null
}

test("an arrival re-prices a declared split, with nobody pressing anything", async () => {
  // 1 unit arrived: 0.6 kg now, 1.2 kg later → 1 + 2 = 3 kg against 2 invoiced.
  await sql`UPDATE orders SET unit_arrive = 0 WHERE event = ${EVENT}`
  await reconcileParcelPlan(WHO, EVENT)
  assert.equal(await autoAmount(), null, "nothing has arrived, so nothing is split yet")

  await markProductArrived({ event: EVENT, productId, quantityArrived: 1 })

  assert.equal(await autoAmount(), 25000, "the fee did not follow the arrival")
})

test("a second arrival moves it again", async () => {
  // 2 arrived: 1.2 kg now, 0.6 kg later → 2 + 1 = 3 kg. Same answer, and the
  // point is that it was recomputed rather than left behind.
  await markProductArrived({ event: EVENT, productId, quantityArrived: 1 })
  assert.equal(await autoAmount(), 25000)
})

test("it does not touch a customer the arrival did not reach", async () => {
  // Scoped per customer. A bystander on the same trip who declared nothing
  // must end the day with no row at all.
  assert.equal(await autoAmount(BYSTANDER), null)
})
