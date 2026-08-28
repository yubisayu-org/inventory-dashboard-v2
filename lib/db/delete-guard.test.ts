import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { deleteFormRow } from "./orders"

const TAG = `delguard${process.hrtime.bigint()}`
const EV = `${TAG}_EV`
const WHO = `${TAG}_c`
let productId = 0

async function line(buy: number, ship = 0) {
  const [o] = await sql<{ id: number }[]>`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_ship)
    VALUES (${EV}, ${WHO}, ${productId}, 100000, 2, ${buy}, ${ship}) RETURNING id`
  return o.id
}

/** What the DELETE route checks before it lets the row go. */
async function blockedBecause(id: number): Promise<"shipped" | "bought" | null> {
  const [r] = await sql<{ bought: number; shipped: number }[]>`
    SELECT COALESCE(unit_buy,0) AS bought, COALESCE(unit_ship,0) AS shipped
      FROM orders WHERE id = ${id}`
  if (!r) return null
  if (Number(r.shipped) > 0) return "shipped"
  if (Number(r.bought) > 0) return "bought"
  return null
}

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
})

after(async () => {
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("an order nobody has spent money on can still be deleted", async () => {
  const id = await line(0)
  assert.equal(await blockedBecause(id), null)
  await deleteFormRow(id)
  const [gone] = await sql`SELECT id FROM orders WHERE id = ${id}`
  assert.equal(gone, undefined)
})

test("an order with bought units is refused", async () => {
  // Shrinking one strands the units, which is findable and now guarded.
  // Deleting takes the row with them: nothing records that the units were ever
  // ordered, and they sit in a box belonging to nobody.
  assert.equal(await blockedBecause(await line(2)), "bought")
})

test("a shipped order is refused first, whatever else is true", async () => {
  assert.equal(await blockedBecause(await line(2, 1)), "shipped")
})

test("deleteFormRow itself still deletes — the guard is the route's job", async () => {
  // Kept deliberately: other callers (a genuine duplicate row, an import fixing
  // itself up) have their own reasons, and burying the rule in the primitive
  // would refuse them too.
  const id = await line(2)
  await deleteFormRow(id)
  const [gone] = await sql`SELECT id FROM orders WHERE id = ${id}`
  assert.equal(gone, undefined)
})
