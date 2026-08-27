import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { setShippingMode, setMergeGroup } from "./shipping-prefs"

const TAG = "prefsby"
const EVENT = `${TAG}_EV`
const OTHER = `${TAG}_EV2`
const WHO = `${TAG}_c`
let customerId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price)
    VALUES (${`${TAG} item`}, ${TAG}, 500, 0) RETURNING id`
  for (const name of [EVENT, OTHER]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${name}, id FROM warehouses ORDER BY id LIMIT 1`
  }
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${WHO}) RETURNING id`
  customerId = c.id
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
    SELECT ${c.id}, id, 25000 FROM warehouses ORDER BY id LIMIT 1`
  for (const name of [EVENT, OTHER]) {
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive)
      VALUES (${name}, ${WHO}, ${p.id}, 100000, 2, 2, 2, 1)`
  }
  // Paid in full on both, so the payment rule is out of the way until a test
  // deliberately puts it back.
  for (const name of [EVENT, OTHER]) {
    await sql`
      INSERT INTO payments (event, customer, amount, is_checked, kind)
      VALUES (${name}, ${WHO}, 225000, true, 'deposit')`
  }
})

after(async () => {
  await sql`DELETE FROM adjustments WHERE event IN (${EVENT}, ${OTHER})`
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ${customerId}`
  await sql`DELETE FROM payments WHERE event IN (${EVENT}, ${OTHER})`
  await sql`DELETE FROM orders WHERE event IN (${EVENT}, ${OTHER})`
  await sql`DELETE FROM events WHERE name IN (${EVENT}, ${OTHER})`
  await sql`DELETE FROM customers WHERE instagram_id = ${WHO}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql.end()
})

async function setBy(event: string) {
  const [row] = (await sql`
    SELECT set_by FROM customer_shipping_prefs
     WHERE customer_id = ${customerId} AND event = ${event}`) as unknown as { set_by: string }[]
  return row?.set_by
}

test("a plan the shop recorded says so", async () => {
  // Without this her page shows a choice she never made, and the first thing
  // she might do is change it — undoing a parcel already packed.
  await setShippingMode(customerId, EVENT, "split", sql, "shop")
  assert.equal(await setBy(EVENT), "shop")
})

test("the customer's own choice is still hers", async () => {
  await setShippingMode(customerId, EVENT, "wait")
  assert.equal(await setBy(EVENT), "customer")
})

test("a merge the shop arranged says so on every trip in the group", async () => {
  await setMergeGroup(customerId, [EVENT, OTHER], sql, "shop")
  assert.equal(await setBy(EVENT), "shop")
  assert.equal(await setBy(OTHER), "shop")
  await setMergeGroup(customerId, [], sql, "shop")
})

test("the shop may plan a parcel for a customer who still owes", async () => {
  // A merge is arranged BEFORE she pays — that is the point, so the discount
  // reaches the invoice she settles. And a split cannot otherwise be undone:
  // its own fee is what makes her unpaid.
  await sql`DELETE FROM payments WHERE event = ${EVENT}`
  await setShippingMode(customerId, EVENT, "split", sql, "shop")
  const [row] = (await sql`
    SELECT mode FROM customer_shipping_prefs
     WHERE customer_id = ${customerId} AND event = ${EVENT}`) as unknown as { mode: string }[]
  assert.equal(row.mode, "split")
})

test("the customer herself is still stopped by it", async () => {
  // The exemption is for the shop alone and must not quietly widen.
  await assert.rejects(() => setShippingMode(customerId, EVENT, "split"), /unpaid/)
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EVENT}, ${WHO}, 225000, true, 'deposit')`
})

test("a parcel that already shipped stops the shop too", async () => {
  // Not a policy — the box has gone. Nobody may re-plan it.
  await sql`UPDATE orders SET unit_ship = unit WHERE event = ${EVENT}`
  await assert.rejects(
    () => setShippingMode(customerId, EVENT, "split", sql, "shop"), /shipped/)
  await sql`UPDATE orders SET unit_ship = 0 WHERE event = ${EVENT}`
})
