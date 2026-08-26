import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { materializeOverpaymentRefunds, getRefunds } from "./finance"

const TAG = `optest${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const HANDLE = `${TAG}_cust`
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO customers (instagram_id) VALUES (${HANDLE})`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  // Ordered 500_000, paid 550_000 — overpaid by 50_000, nothing marked.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EVENT}, ${HANDLE}, ${productId}, 500000, 1)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EVENT}, ${HANDLE}, 550000, true, 'deposit')`
})

after(async () => {
  await sql`DELETE FROM refunds WHERE event = ${EVENT}`
  await sql`DELETE FROM payments WHERE event = ${EVENT}`
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id = ${HANDLE}`
  await sql.end()
})

test("an overpayment no longer creates a refund by itself", async () => {
  // The whole point: nothing appears in Pending that nobody asked for.
  await materializeOverpaymentRefunds()
  const rows = await getRefunds({ event: EVENT })
  assert.equal(rows.length, 0, "the detector must not insert")
})

test("a reconciled row holds only what other refunds do not", async () => {
  // A mark refunded 200_000 of the 250_000 she is owed; an older auto-created
  // overpayment row must settle at 50_000, not 250_000, or the two together
  // claim 450_000 against a 250_000 debt.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EVENT}, ${HANDLE}, ${productId}, -200000, 1)`
  const [mark] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EVENT}, ${HANDLE}, 'unavailable', 200000, 'pending') RETURNING id`
  const [auto] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EVENT}, ${HANDLE}, 'overpayment', 250000, 'pending') RETURNING id`

  await materializeOverpaymentRefunds()

  const [row] = await sql<{ refund_amount: number }[]>`
    SELECT refund_amount FROM refunds WHERE id = ${auto.id}`
  assert.equal(row.refund_amount, 50000)

  const [other] = await sql<{ refund_amount: number }[]>`
    SELECT refund_amount FROM refunds WHERE id = ${mark.id}`
  assert.equal(other.refund_amount, 200000, "a mark's row is never rewritten")
})
