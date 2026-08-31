import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { markProductArrived } from "./fulfillment"

/**
 * Receiving happens in front of ONE box.
 *
 * The arrival list is filtered by route; marking was not. So marking seven
 * units on the air tab spread them across every pending line for that product
 * in the trip, paid customers first -- and units physically in the CJI box were
 * credited to customers whose goods were still in HC/KS, while the air tab kept
 * showing leftovers because its own lines had not been filled. That is what
 * "I marked 7 and 2 are still there" was. Six lines went to the wrong box on
 * 30 Aug 2026 before it was found.
 */

const TAG = `routealloc${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
let productId = 0

async function setup() {
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  const [p] = (await sql`
    INSERT INTO products (name, store, price, gram)
    VALUES (${`${TAG} Eco Bag`}, 'MUJI', 1000, 100)
    RETURNING id
  `) as unknown as { id: number }[]
  productId = p.id

  // Two boxes on two routes. CJI is the air one; HC/KS went by sea.
  const rows: [string, string, number][] = [
    [`${TAG}_air1`, "CJI-99", 2],
    [`${TAG}_air2`, "CJI-99", 3],
    [`${TAG}_sea1`, "HC/KS", 4],
  ]
  for (const [customer, receipt, units] of rows) {
    await sql`INSERT INTO customers (instagram_id) VALUES (${customer})`
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit,
                          unit_buy, unit_dispatch, dispatch_receipt, dispatched_at)
      VALUES (${EVENT}, ${customer}, ${productId}, 1000, ${units},
              ${units}, ${units}, ${receipt}, NOW())
    `
  }
}

async function arrivedByRoute() {
  const rows = (await sql`
    SELECT dispatch_receipt AS receipt, COALESCE(SUM(unit_arrive), 0)::int AS arrived
      FROM orders WHERE event = ${EVENT} GROUP BY dispatch_receipt ORDER BY dispatch_receipt
  `) as unknown as { receipt: string; arrived: number }[]
  return Object.fromEntries(rows.map((r) => [r.receipt, r.arrived]))
}

test("marking on a route fills only that route's lines", async () => {
  await setup()

  // Five units are what the air tab shows: 2 + 3. Mark exactly that.
  const res = await markProductArrived({
    event: EVENT, productId, quantityArrived: 5, route: "air",
  })

  const arrived = await arrivedByRoute()
  assert.equal(arrived["CJI-99"], 5, "the box in front of her is fully received")
  assert.equal(arrived["HC/KS"], 0, "the box still at sea is untouched")
  assert.equal(res.unassignedUnits, 0)
})

test("more units than the route holds are left unassigned, not spilled next door", async () => {
  // She types 9 by mistake. The extra four must not go to the other box.
  const res = await markProductArrived({
    event: EVENT, productId, quantityArrived: 9, route: "air",
  })
  const arrived = await arrivedByRoute()
  assert.equal(arrived["CJI-99"], 5, "already full, nothing more to give")
  assert.equal(arrived["HC/KS"], 0)
  assert.equal(res.unassignedUnits, 9, "all nine had nowhere to go on this route")
})

test("no route named still fills everything, which is what the All tab means", async () => {
  const res = await markProductArrived({ event: EVENT, productId, quantityArrived: 4 })
  const arrived = await arrivedByRoute()
  assert.equal(arrived["HC/KS"], 4)
  assert.equal(res.unassignedUnits, 0)
})

after(async () => {
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM customer_shipping_prefs WHERE event = ${EVENT}`
  await sql`DELETE FROM adjustments WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM products WHERE id = ${productId}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})
