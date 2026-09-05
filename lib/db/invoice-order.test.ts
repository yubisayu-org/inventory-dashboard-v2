import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getInvoiceForCustomer } from "./invoice"

// Seven of the seventeen trips in production were imported and carry the same
// creation timestamp to the microsecond, four of them on one day — so ordering
// by creation left their order to the alphabet, and no edit could change it.
// Order history follows the last time an event was touched instead, which is
// something the shop can set by hand.
const TAG = `invord${process.hrtime.bigint()}`
const OLD = `${TAG}_A_OLDEST`
const MID = `${TAG}_B_MIDDLE`
const FRESH = `${TAG}_C_NEWEST`
const WHO = `${TAG}_cust`
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`

  // Created oldest-to-newest in the order A, B, C.
  for (const [i, name] of [OLD, MID, FRESH].entries()) {
    await sql`
      INSERT INTO events (name, warehouse_id, created_at)
      SELECT ${name}, id, NOW() - ${`${3 - i} days`}::interval FROM warehouses ORDER BY id LIMIT 1`
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit)
      VALUES (${name}, ${WHO}, ${productId}, 100000, 1)`
  }
})

after(async () => {
  await sql`DELETE FROM orders WHERE customer = ${WHO}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id = ${WHO}`
  await sql.end()
})

async function order() {
  const result = await getInvoiceForCustomer(WHO)
  return result.events.map((e) => e.eventId).filter((id) => id.startsWith(TAG))
}

test("an untouched trip is placed by when it was created", async () => {
  // updated_at is null until the first edit. Without the fallback the newest
  // trip of all sorts to the bottom — which is where POCN202608 sat.
  assert.deepEqual(await order(), [FRESH, MID, OLD])
})

test("touching a trip moves it to the top", async () => {
  await sql`UPDATE events SET updated_at = NOW() WHERE name = ${OLD}`
  assert.deepEqual(await order(), [OLD, FRESH, MID])

  // Touched in turn, they end up in the order they were touched, latest first
  // — which is how the shop sets this list by hand.
  await sql`UPDATE events SET updated_at = NOW() + interval '1 second' WHERE name = ${MID}`
  await sql`UPDATE events SET updated_at = NOW() + interval '2 seconds' WHERE name = ${FRESH}`
  assert.deepEqual(await order(), [FRESH, MID, OLD])
})
