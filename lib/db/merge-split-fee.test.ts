import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { setShippingMode, setMergeGroup } from "./shipping-prefs"
import { reconcileParcelPlan } from "./parcel-plan"

// tyanandya_'s shape. Two trips in one box, one of them leaving an item behind:
// the merge saves a kilo and the second parcel costs one, so the plan owes
// nothing — and the credit it would otherwise write must not stand alone.
//
// Before this, a merged box sent with stock still coming was priced as one
// parcel: the group kept its merge credit and nobody paid for the second box.
// Nine trips went out that way.
const TAG = `mergesplit${process.hrtime.bigint()}`
const BIG = `${TAG}_A_BIG`
const SMALL = `${TAG}_B_SMALL`
const WHO = `${TAG}_cust`
const RATE = 8000
let customerId = 0
let heavyId = 0
let lightId = 0

async function adjustments() {
  return await sql<{ event: string; amount: number; description: string }[]>`
    SELECT event, amount::int AS amount, description FROM adjustments
     WHERE customer = ${WHO} AND auto ORDER BY event`
}

before(async () => {
  const [heavy] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price) VALUES (${`${TAG} heavy`}, ${TAG}, 1375, 0) RETURNING id`
  const [light] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price) VALUES (${`${TAG} light`}, ${TAG}, 60, 0) RETURNING id`
  const [rest] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price) VALUES (${`${TAG} rest`}, ${TAG}, 100, 0) RETURNING id`
  heavyId = heavy.id
  lightId = light.id

  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${WHO}) RETURNING id`
  customerId = c.id
  for (const e of [BIG, SMALL]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
  }
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
    SELECT ${customerId}, id, ${RATE} FROM warehouses ORDER BY id LIMIT 1`

  // BIG: 1.375 g here, 100 g still coming. SMALL: 60 g, all here.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
    VALUES (${BIG}, ${WHO}, ${heavyId}, 100000, 1, 1)`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
    VALUES (${BIG}, ${WHO}, ${rest.id}, 100000, 1, 0)`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
    VALUES (${SMALL}, ${WHO}, ${lightId}, 100000, 1, 1)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${BIG}, ${WHO}, 500000, true, 'deposit'), (${SMALL}, ${WHO}, 200000, true, 'deposit')`
})

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM adjustments WHERE customer = ${WHO}`
  await sql`DELETE FROM payments WHERE customer = ${WHO}`
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM orders WHERE customer = ${WHO}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE id = ${customerId}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql.end()
})

test("a merge alone credits the saving", async () => {
  await setMergeGroup(customerId, [BIG, SMALL])
  for (const e of [BIG, SMALL]) await reconcileParcelPlan(WHO, e)

  // 1.375 + 60 + 100 = 1.535 g in one box = 2 kg, against 2 kg + 1 kg invoiced.
  const rows = await adjustments()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].amount, -RATE, "one kilo saved")
})

test("declaring the early box cancels it, because the second parcel costs it", async () => {
  // What the merge modal now does before it ships a box with stock still
  // coming — and what it never did, which left the credit standing alone.
  await setShippingMode(customerId, BIG, "split")
  for (const e of [BIG, SMALL]) await reconcileParcelPlan(WHO, e)

  // early 1.375 + 60 = 2 kg, rest 100 g = 1 kg, so 3 kg planned against 3 kg
  // invoiced: nothing owed either way.
  assert.deepEqual([...(await adjustments())], [], "the merge credit goes with the second box")
})
