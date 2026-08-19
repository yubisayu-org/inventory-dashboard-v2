import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getCustomerOrders, getCustomerBalance } from "./catalogue-orders"

const TAG = `ordtest${process.hrtime.bigint()}`
const MINE = `${TAG}_mine`
const THEIRS = `${TAG}_theirs`
const EVENT = `${TAG}_EVENT`

after(async () => {
  await sql`DELETE FROM orders WHERE customer IN (${MINE}, ${THEIRS})`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

async function seed() {
  await sql`INSERT INTO customers (instagram_id) VALUES (${MINE}), (${THEIRS})`
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`

  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_ship)
    VALUES (${EVENT}, ${MINE}, ${p.id}, 50000, 4, 4, 2)`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EVENT}, ${MINE}, ${p.id}, 20000, 1)`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EVENT}, ${THEIRS}, ${p.id}, 99000, 9)`
}

test("returns only this customer's orders", async () => {
  await seed()
  const mine = await getCustomerOrders(MINE)
  assert.equal(mine.length, 2)
  assert.ok(!mine.some((o) => o.unitPrice === 99000), "must never include another customer's order")
})

test("a handle with @ and different case resolves the same", async () => {
  const upper = await getCustomerOrders(`@${MINE.toUpperCase()}`)
  assert.equal(upper.length, 2)
})

test("computes line totals", async () => {
  const [newest] = await getCustomerOrders(MINE)
  // Newest first: the single-unit order was inserted last.
  assert.equal(newest.total, newest.qty * newest.unitPrice)
})

test("reports the furthest stage reached, and whether it is complete", async () => {
  const orders = await getCustomerOrders(MINE)
  const partial = orders.find((o) => o.qty === 4)
  // 2 of 4 shipped: shipped is the furthest stage with any quantity, but not
  // all of it — saying "shipped" flatly would be a half-truth.
  assert.equal(partial?.stage, "shipped")
  assert.equal(partial?.stageComplete, false)

  const untouched = orders.find((o) => o.qty === 1)
  assert.equal(untouched?.stage, "ordered")
})

test("a customer with no invoices has a zero balance, not an error", async () => {
  const balance = await getCustomerBalance(`${TAG}_nobody`)
  assert.deepEqual(balance, { invoiceCount: 0, totalInvoiced: 0, totalOutstanding: 0 })
})

test("returns a balance for a customer with orders", async () => {
  const balance = await getCustomerBalance(MINE)
  assert.ok(balance.totalInvoiced > 0, "orders should produce an invoiced total")
})
