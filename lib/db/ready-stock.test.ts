import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { listReadyStock, listHiddenReadyStock } from "./ready-stock"

const TAG = `stocktest${process.hrtime.bigint()}`
const EVENT = `${TAG}_EVENT`
const NAMED = `${TAG} Matched Item`
const UNNAMED = `${TAG} typed by hand`
const SHIPPING = `${TAG} Still Shipping`

after(async () => {
  await sql`DELETE FROM excess_purchase WHERE items LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql.end()
})

async function seed() {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO products (name, store, price)
    VALUES (${NAMED}, 'test', 100000), (${SHIPPING}, 'test', 100000)`
  // Fully arrived, partly arrived, wholly still shipping, and one whose text
  // matches no product.
  await sql`
    INSERT INTO excess_purchase (event, items, unit_buy, unit_arrive)
    VALUES (${EVENT}, ${NAMED}, 3, 3)`
  await sql`
    INSERT INTO excess_purchase (event, items, unit_buy, unit_arrive)
    VALUES (${EVENT}, ${NAMED}, 5, 2)`
  await sql`
    INSERT INTO excess_purchase (event, items, unit_buy, unit_arrive)
    VALUES (${EVENT}, ${SHIPPING}, 6, 0)`
  await sql`
    INSERT INTO excess_purchase (event, items, unit_buy, unit_arrive)
    VALUES (${EVENT}, ${UNNAMED}, 4, 4)`
}

const mine = <T extends { name: string }>(rows: T[]) => rows.filter((r) => r.name.startsWith(TAG))

test("matched stock is listed with its product price", async () => {
  await seed()
  const rows = mine(await listReadyStock())
  assert.equal(rows.length, 2, "the unmatched row must not be offered")
  assert.ok(rows.every((r) => r.price === 100000))
  assert.ok(rows.every((r) => r.productId > 0), "a request needs a product to attach to")
})

// unit_arrive is what landed; the rest of unit_buy is still shipping and is
// not offered at all. A partly-arrived row is offered at what is in hand, not
// at what was bought — quoting the whole would sell units that are on a boat.
test("only what has landed is offered, and only as much as has landed", async () => {
  const rows = mine(await listReadyStock())
  assert.deepEqual(rows.map((r) => r.readyQty).sort(), [2, 3])
})

test("a row still wholly in transit is not on the shelf", async () => {
  const rows = mine(await listReadyStock())
  assert.ok(!rows.some((r) => r.name === SHIPPING))
})

test("the payload carries no in-transit figure at all", async () => {
  // Not merely undrawn — absent. The page cannot leak what it was never sent.
  const [row] = mine(await listReadyStock())
  assert.ok(row)
  assert.ok(!("transitQty" in row))
})

// An unpriced item invites an order the shop cannot quote, so it is hidden —
// but hiding it silently would let stock sit invisible for months.
test("stock matching no product is hidden, and reported to the shop", async () => {
  const offered = mine(await listReadyStock())
  assert.ok(!offered.some((r) => r.name === UNNAMED))

  const hidden = mine(await listHiddenReadyStock())
  assert.deepEqual(hidden.map((r) => ({ name: r.name, qty: r.qty })), [{ name: UNNAMED, qty: 4 }])
})

test("a row with nothing left is not offered", async () => {
  await sql`
    INSERT INTO excess_purchase (event, items, unit_buy, unit_arrive)
    VALUES (${EVENT}, ${NAMED}, 0, 0)`
  const rows = mine(await listReadyStock())
  assert.ok(rows.every((r) => r.readyQty > 0))
})
