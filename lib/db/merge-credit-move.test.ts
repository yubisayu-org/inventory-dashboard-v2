import { test, beforeEach, afterEach, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { setMergeGroup } from "./shipping-prefs"
import { reconcileParcelPlan } from "./parcel-plan"

// taleofblackcats: a credit written before the tie-break existed, sitting on
// the invoice she had already paid delivery on. Recomputing moves it to the
// other invoice of the same pairing -- which is one event to her, not the end
// of the merge and the start of another.
const TAG = `creditmove${process.hrtime.bigint()}`
const PAID = `${TAG}_A_PAID` // delivery already inside her payment
const OWING = `${TAG}_B_OWING` // goods only, so the discount belongs here
const WHO = `${TAG}_cust`
const RATE = 50000
let customerId = 0

async function rows() {
  return [...await sql<{ event: string; amount: number; description: string }[]>`
    SELECT event, amount::int AS amount, description FROM adjustments
     WHERE customer = ${WHO} AND auto ORDER BY event`]
}

async function notices() {
  return [...await sql<{ title: string; body: string }[]>`
    SELECT title, body FROM announcements WHERE customer_id = ${customerId} ORDER BY id`]
}

beforeEach(async () => {
  const [heavy] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price) VALUES (${`${TAG} a`}, ${TAG}, 300, 0) RETURNING id`
  const [light] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price) VALUES (${`${TAG} b`}, ${TAG}, 100, 0) RETURNING id`
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${WHO}) RETURNING id`
  customerId = c.id
  for (const e of [PAID, OWING]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
  }
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
    SELECT ${customerId}, id, ${RATE} FROM warehouses ORDER BY id LIMIT 1`
  // Nothing marked arrived: the credit arithmetic reads what is still to send,
  // not what has landed, and stock that has landed would put this pairing into
  // the shop-wide "ready to combine" count another test measures as a delta.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
    VALUES (${PAID}, ${WHO}, ${heavy.id}, 582000, 1, 0), (${OWING}, ${WHO}, ${light.id}, 299000, 1, 0)`
  // Goods plus delivery on one, goods alone on the other.
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${PAID}, ${WHO}, 632000, true, 'deposit'), (${OWING}, ${WHO}, 299000, true, 'deposit')`
  await setMergeGroup(customerId, [PAID, OWING])
  // The row as it was written before 4 Sep: on the trip she had already paid
  // delivery on, which is the one the tie-break now leaves charged.
  await sql`
    INSERT INTO adjustments (event, customer, description, amount, auto)
    VALUES (${PAID}, ${WHO}, ${`Gabung ongkir dengan ${OWING}`}, ${-RATE}, true)`
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
})

afterEach(async () => {
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM adjustments WHERE customer = ${WHO}`
  await sql`DELETE FROM payments WHERE customer = ${WHO}`
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM orders WHERE customer = ${WHO}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE id = ${customerId}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
})

after(async () => { await sql.end() })

for (const [name, order] of [
  ["losing trip first", [PAID, OWING]],
  ["receiving trip first", [OWING, PAID]],
] as [string, string[]][]) {
  test(`the credit moves to the unpaid trip, ${name}`, async () => {
    for (const e of order) await reconcileParcelPlan(WHO, e)

    const adjustments = await rows()
    assert.equal(adjustments.length, 1, "one credit, not one on each invoice")
    assert.equal(adjustments[0].event, OWING)
    assert.equal(adjustments[0].amount, -RATE)
    assert.equal(adjustments[0].description, `Gabung ongkir dengan ${PAID}`)
  })

  test(`she is told once that it moved, ${name}`, async () => {
    for (const e of order) await reconcileParcelPlan(WHO, e)

    const said = await notices()
    assert.equal(said.length, 1, `one notice, got: ${said.map((n) => n.title).join(" / ")}`)
    assert.match(said[0].body, /kini tercatat di tagihan/)
    assert.match(said[0].body, new RegExp(OWING))
    assert.match(said[0].body, new RegExp(PAID))
    // The sentence that started this: a merge that never stopped, announced
    // as though it had.
    assert.doesNotMatch(said[0].body, /tidak lagi digabung/)
  })
}

test("a merge that genuinely ends still says so", async () => {
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  for (const e of [PAID, OWING]) await reconcileParcelPlan(WHO, e)

  assert.deepEqual(await rows(), [])
  const said = await notices()
  assert.equal(said.length, 1)
  assert.match(said[0].body, /tidak lagi digabung/)
})
