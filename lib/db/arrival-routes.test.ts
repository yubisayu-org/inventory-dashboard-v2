import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getArrivalList } from "./fulfillment"

// A product half flown and half shipped belongs to both tabs — but each tab
// must report only the units that travelled that way. Reading 9 under Air
// Cargo when 5 flew sends someone to the bench looking for four boxes that are
// still at sea.

const TAG = `routetest${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const HANDLE = `${TAG}_cust`
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO customers (instagram_id) VALUES (${HANDLE})`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`

  // 5 units flew, 4 came by sea, none has arrived yet.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, dispatch_receipt, dispatched_at)
    VALUES (${EVENT}, ${HANDLE}, ${productId}, 100000, 5, 5, 5, ${`CJI-${TAG}`}, NOW())`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, dispatch_receipt, dispatched_at)
    VALUES (${EVENT}, ${HANDLE}, ${productId}, 100000, 4, 4, 4, ${`MNC-${TAG}`}, NOW())`
})

after(async () => {
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id = ${HANDLE}`
  await sql.end()
})

test("unfiltered, the item carries every unit still in transit", async () => {
  const items = await getArrivalList(EVENT)
  assert.equal(items.length, 1)
  assert.equal(items[0].totalPending, 9)
})

test("air cargo reports the units that flew, not the whole order", async () => {
  const items = await getArrivalList(EVENT, "air")
  assert.equal(items.length, 1)
  assert.equal(items[0].totalPending, 5, "the four still at sea are not on this tab")
  assert.equal(items[0].orders.length, 1)
})

test("sea cargo reports the rest, and the two tabs add up", async () => {
  const air = await getArrivalList(EVENT, "air")
  const sea = await getArrivalList(EVENT, "sea")
  assert.equal(sea[0].totalPending, 4)
  assert.equal(air[0].totalPending + sea[0].totalPending, 9)
})

test("a tab nothing travelled on is empty rather than showing everything", async () => {
  const items = await getArrivalList(EVENT, "hc")
  assert.equal(items.length, 0)
})

test("an unrecognised receipt lands in other", async () => {
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, dispatch_receipt, dispatched_at)
    VALUES (${EVENT}, ${HANDLE}, ${productId}, 100000, 2, 2, 2, ${`POCN-${TAG}`}, NOW())`
  const items = await getArrivalList(EVENT, "other")
  assert.equal(items.length, 1)
  assert.equal(items[0].totalPending, 2)
})
