import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import {
  cancelOrderLines,
  recordCustomerCancellation,
  recordMissingArrival,
  recordBrokenArrival,
  recordWrongProduct,
} from "./orders"

const TAG = `shipguard${process.hrtime.bigint()}`
const EV = `${TAG}_EV`
const WHO = `${TAG}_c`
let productId = 0

/** A line of 3, of which `shipped` have already gone out. */
async function line(shipped: number, arrive = 3) {
  const [o] = await sql<{ id: number }[]>`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive, unit_ship)
    VALUES (${EV}, ${WHO}, ${productId}, 100000, 3, 3, 3, ${arrive}, ${shipped}) RETURNING id`
  return o.id
}

async function read(id: number) {
  const [r] = await sql<{ unit: number; unit_buy: number; unit_dispatch: number; unit_arrive: number; unit_ship: number }[]>`
    SELECT unit, unit_buy, unit_dispatch, unit_arrive, unit_ship FROM orders WHERE id = ${id}`
  return r
}

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
})

after(async () => {
  await sql`DELETE FROM excess_purchase WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("a line with nothing shipped still cancels to zero", async () => {
  const id = await line(0)
  await cancelOrderLines([id])
  assert.deepEqual(await read(id), {
    unit: 0, unit_buy: 0, unit_dispatch: 0, unit_arrive: 0, unit_ship: 0,
  })
})

test("a shipped unit stays on the invoice", async () => {
  // The bill is SUM(unit_price * unit). Zeroing a line whose parcel has gone
  // takes the charge away and leaves the goods with her.
  const id = await line(1)
  await cancelOrderLines([id])
  const r = await read(id)
  assert.equal(r.unit, 1, "she has one, so she owes for one")
  assert.equal(r.unit_buy, 1, "and one was bought and is gone")
  assert.equal(r.unit_arrive, 1)
  assert.equal(r.unit_dispatch, 1)
})

test("a fully shipped line cannot be cancelled away at all", async () => {
  const id = await line(3)
  await cancelOrderLines([id])
  const r = await read(id)
  assert.equal(r.unit, 3, "everything went; there is nothing to cancel")
})

test("every arrival-list route that cancels is covered", async () => {
  // All four reach cancelOrderLines, so the guard has to hold through each of
  // them rather than only where it is called directly.
  const cancelled = await line(1)
  await recordCustomerCancellation({ event: EV, productName: "x", cancelOrderIds: [cancelled] })
  assert.equal((await read(cancelled)).unit, 1, "customer_cancelled")

  const missing = await line(1)
  await recordMissingArrival({ cancelOrderIds: [missing] })
  assert.equal((await read(missing)).unit, 1, "missing")

  const broken = await line(1)
  await recordBrokenArrival({ event: EV, productName: "x", qty: 1, cancelOrderIds: [broken] })
  assert.equal((await read(broken)).unit, 1, "broken")

  const wrong = await line(1)
  await recordWrongProduct({
    event: EV, expectedItem: "x", receivedItem: "y", qty: 1, cancelOrderIds: [wrong],
  })
  assert.equal((await read(wrong)).unit, 1, "wrong_product")
})

test("the stock returned to Inventory still excludes what shipped", async () => {
  // recordCustomerCancellation always knew this -- the point is the guard did
  // not change what it banks.
  const id = await line(1)
  const { excessUnits } = await recordCustomerCancellation({
    event: EV, productName: "banked", cancelOrderIds: [id],
  })
  assert.equal(excessUnits, 2, "3 bought, 1 gone, 2 back on the shelf")
})
