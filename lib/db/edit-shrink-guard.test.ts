import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { updateFormRow, bankStrandedBoughtUnits } from "./orders"

const TAG = `shrink${process.hrtime.bigint()}`
const EV = `${TAG}_EV`
const WHO = `${TAG}_c`
let productId = 0

async function line(unit: number, buy: number, ship = 0, note = "") {
  const [o] = await sql<{ id: number }[]>`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive, unit_ship, note)
    VALUES (${EV}, ${WHO}, ${productId}, 100000, ${unit}, ${buy}, ${buy}, ${buy}, ${ship}, ${note})
    RETURNING id`
  return o.id
}

const read = async (id: number) => {
  const [r] = await sql<{ unit: number; unit_buy: number; note: string }[]>`
    SELECT unit, unit_buy, note FROM orders WHERE id = ${id}`
  return r
}

const shelved = async (reason: string) => {
  const rows = await sql<{ unit_buy: number }[]>`
    SELECT unit_buy FROM excess_purchase WHERE event = ${EV} AND reason = ${reason}`
  return rows.reduce((n, r) => n + Number(r.unit_buy), 0)
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

test("a staff slip shelves the units as overbuy and says so on the line", async () => {
  // Two typed, one meant. The second was bought before anyone noticed.
  const id = await line(2, 2, 0, "minta warna hitam")
  await updateFormRow(id, { event: EV, customer: WHO, productId, unitPrice: 100000, unit: 1, note: "minta warna hitam" })
  const { banked } = await bankStrandedBoughtUnits(id, sql, "staff_mistake")

  assert.equal(banked, 1)
  assert.equal(await shelved("overbuy"), 1, "the shop's own surplus")
  const r = await read(id)
  assert.equal(r.unit_buy, 1, "the order stops claiming it")
  assert.match(r.note, /minta warna hitam/, "what she asked for is not overwritten")
  assert.match(r.note, /salah input/, "and the line says why it shrank")
})

test("a change of mind shelves them as a cancellation, not a slip", async () => {
  const id = await line(2, 2)
  await updateFormRow(id, { event: EV, customer: WHO, productId, unitPrice: 100000, unit: 1, note: "" })
  const { banked } = await bankStrandedBoughtUnits(id, sql, "customer_changed_mind")

  assert.equal(banked, 1)
  assert.equal(await shelved("customer_cancelled"), 1)
  assert.match((await read(id)).note, /customer batal/)
})

test("the two are told apart on the shelf", async () => {
  // A month later, "we bought two by accident" and "she changed her mind" are
  // not the same story, and the Inventory row is where anyone will look.
  assert.equal(await shelved("overbuy"), 1)
  assert.equal(await shelved("customer_cancelled"), 1)
})
