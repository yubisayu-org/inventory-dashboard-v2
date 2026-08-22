import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getCustomerBalance } from "./catalogue-orders"
import { getPublicInvoiceForCustomer } from "./invoice"

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

// The catalogue's order history is getPublicInvoiceForCustomer — the same
// query behind the public recap site. These cover it through the handle the
// catalogue passes it: whatever else changes, one customer must never see
// another's lines.
test("returns only this customer's orders", async () => {
  await seed()
  const { events } = await getPublicInvoiceForCustomer(MINE, sql)
  const lines = events.flatMap((e) => e.orders)
  assert.equal(lines.length, 2)
  assert.ok(
    !lines.some((l) => l.price === "99.000"),
    "must never include another customer's order",
  )
})

test("a handle with @ and different case resolves the same", async () => {
  const { events } = await getPublicInvoiceForCustomer(`@${MINE.toUpperCase()}`, sql)
  assert.equal(events.flatMap((e) => e.orders).length, 2)
})

test("line and event totals add up", async () => {
  const { events } = await getPublicInvoiceForCustomer(MINE, sql)
  const [ev] = events
  // 4 × 50.000 + 1 × 20.000
  assert.equal(ev.totals.unit, 5)
  assert.equal(ev.totals.subtotal, 220000)
  assert.equal(ev.invoice.subtotalBarang, 220000)
})

test("reports how much of each line is ready", async () => {
  const { events } = await getPublicInvoiceForCustomer(MINE, sql)
  const lines = events.flatMap((e) => e.orders)
  // Nothing has arrived: 2 of 4 shipped, but unit_arrive was never set.
  assert.ok(lines.every((l) => l.unitArrive === 0))
})

test("a customer with no invoices has a zero balance, not an error", async () => {
  const balance = await getCustomerBalance(`${TAG}_nobody`)
  assert.deepEqual(balance, { invoiceCount: 0, totalInvoiced: 0, totalOutstanding: 0 })
})

test("returns a balance for a customer with orders", async () => {
  const balance = await getCustomerBalance(MINE)
  assert.ok(balance.totalInvoiced > 0, "orders should produce an invoiced total")
})
