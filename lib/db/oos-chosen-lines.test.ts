import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { markProductOutOfStock } from "./shopping-list"

// A shortage is answered one customer at a time: she asks everybody waiting
// whether they want a swap or their money back, and the answers arrive over a
// week. The automatic pick -- unpaid first, newest first -- cannot cut exactly
// the two who said refund, so the choice travels with the request.
const TAG = `ooschoice${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const SAID_REFUND = `${TAG}_a_refund`
const STILL_THINKING = `${TAG}_b_thinking`
const WANTS_SWAP = `${TAG}_c_swap`
let productId = 0
const orderIds: Record<string, number> = {}

async function unitsLeft(who: string) {
  const [row] = await sql<{ unit: number }[]>`
    SELECT unit::int AS unit FROM orders WHERE id = ${orderIds[who]}`
  return row.unit
}

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    SELECT id FROM products WHERE COALESCE(gram, 0) = 0 ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  // Inserted oldest first, so the automatic pick would take them in the
  // opposite order to the one the answers arrived in.
  for (const who of [SAID_REFUND, STILL_THINKING, WANTS_SWAP]) {
    await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
    const [o] = await sql<{ id: number }[]>`
      INSERT INTO orders (event, customer, product_id, unit_price, unit)
      VALUES (${EVENT}, ${who}, ${productId}, 100000, 2) RETURNING id`
    orderIds[who] = o.id
  }
})

after(async () => {
  await sql`DELETE FROM adjustments WHERE event = ${EVENT}`
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("only the lines she named lose units", async () => {
  const result = await markProductOutOfStock({
    event: EVENT,
    productId,
    quantityOutOfStock: 3,
    allocations: [
      { orderId: orderIds[SAID_REFUND], units: 2 },
      { orderId: orderIds[WANTS_SWAP], units: 1 },
    ],
  }, "tester")

  assert.equal(result.reducedUnits, 3)
  assert.equal(await unitsLeft(SAID_REFUND), 0, "she asked for her money back")
  assert.equal(await unitsLeft(WANTS_SWAP), 1, "one of his two came off")
  assert.equal(
    await unitsLeft(STILL_THINKING), 2,
    "the customer who has not answered keeps every unit — this is the whole point",
  )
})

test("more units than a line is waiting on is refused, and nothing moves", async () => {
  const before = await unitsLeft(STILL_THINKING)
  await assert.rejects(
    markProductOutOfStock({
      event: EVENT,
      productId,
      quantityOutOfStock: 9,
      allocations: [{ orderId: orderIds[STILL_THINKING], units: 9 }],
    }, "tester"),
    /still pending/,
  )
  assert.equal(await unitsLeft(STILL_THINKING), before)
})

test("a line that is not waiting on this item at all is refused", async () => {
  await assert.rejects(
    markProductOutOfStock({
      event: EVENT,
      productId,
      quantityOutOfStock: 1,
      allocations: [{ orderId: 0, units: 1 }],
    }, "tester"),
    /not waiting on this item/,
  )
})

test("without a choice it still picks for itself", async () => {
  // The ordinary shortage: nobody to wait for, so the automatic order stands.
  // All three are unpaid, so it takes the newest order still holding units --
  // the swap line, which kept one unit from the test above.
  const waiting = await unitsLeft(STILL_THINKING)
  const result = await markProductOutOfStock(
    { event: EVENT, productId, quantityOutOfStock: 1 }, "tester")

  assert.equal(result.reducedUnits, 1)
  assert.equal(await unitsLeft(WANTS_SWAP), 0, "newest unpaid line first")
  assert.equal(await unitsLeft(STILL_THINKING), waiting, "the older line is still untouched")
})
