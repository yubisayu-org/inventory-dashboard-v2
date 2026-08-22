import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { listReadyStock, listHiddenReadyStock } from "./ready-stock"

const TAG = `stocktest${process.hrtime.bigint()}`
const EVENT = `${TAG}_EVENT`
const NAMED = `${TAG} Matched Item`
const UNNAMED = `${TAG} typed by hand`

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
    VALUES (${NAMED}, 'test', 100000)`
  // Fully arrived, partly arrived, and one whose text matches no product.
  await sql`
    INSERT INTO excess_purchase (event, items, unit_buy, unit_arrive)
    VALUES (${EVENT}, ${NAMED}, 3, 3)`
  await sql`
    INSERT INTO excess_purchase (event, items, unit_buy, unit_arrive)
    VALUES (${EVENT}, ${NAMED}, 5, 2)`
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

// unit_arrive is what landed; the rest of unit_buy is still shipping. Both are
// shown so a customer deciding whether to wait knows the rest exists.
test("ready and in-transit quantities are split, not summed", async () => {
  const rows = mine(await listReadyStock())
  const full = rows.find((r) => r.readyQty + r.transitQty === 3)
  const partial = rows.find((r) => r.readyQty + r.transitQty === 5)
  assert.deepEqual({ ready: full?.readyQty, transit: full?.transitQty }, { ready: 3, transit: 0 })
  assert.deepEqual({ ready: partial?.readyQty, transit: partial?.transitQty }, { ready: 2, transit: 3 })
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
  assert.ok(rows.every((r) => r.readyQty + r.transitQty > 0))
})
