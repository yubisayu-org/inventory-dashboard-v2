import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { keepRefundOnAccount, getRefunds } from "./finance"
import { heldDeposits } from "./deposits"

const TAG = `keepacct${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const WHO = `${TAG}_c`
let productId = 0

async function refund(reason: string, amount: number, status = "pending") {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status,
                         bank_name, bank_account_number, bank_account_holder)
    VALUES (${EVENT}, ${WHO}, ${reason}, ${amount}, ${status}, 'BCA', '123', 'Her Name')
    RETURNING id`
  return r.id
}

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products WHERE COALESCE(gram,0) = 0 ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
  // Ordered 200.000, paid 500.000 — overpaid by 300.000.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EVENT}, ${WHO}, ${productId}, 200000, 1)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EVENT}, ${WHO}, 500000, true, 'deposit')`
})

after(async () => {
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM refunds WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("keeping it parks the money without moving any", async () => {
  const id = await refund("quality", 120000)
  await keepRefundOnAccount(id, "tester")

  const [row] = await sql<{ status: string; bank_account_number: string }[]>`
    SELECT status, bank_account_number FROM refunds WHERE id = ${id}`
  assert.equal(row.status, "applied_to_next_order")
  assert.equal(row.bank_account_number, "", "the account was for sending to; nothing is being sent")

  const [{ n }] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM payments WHERE refund_id = ${id}`
  assert.equal(n, "0", "a deposit is a promise, not a payment")

  const held = await heldDeposits(WHO)
  assert.ok(held.some((d) => d.refundId === id && d.amount === 120000),
    "and the invoice banner can now offer it")
})

test("a live overpayment freezes at what is owed, not at what the row said", async () => {
  // A pending overpayment reads from her balance, and a balance moves. The
  // moment she says "keep it" the money stops being a claim on that trip, so
  // the figure has to stop moving too -- and it stops at the live one. The row
  // below was written with a stale 482.000, which is exactly the shape of the
  // production row that started this work.
  const id = await refund("overpayment", 482000)
  await keepRefundOnAccount(id, "tester")

  const [row] = await sql<{ refund_amount: number }[]>`
    SELECT refund_amount::int FROM refunds WHERE id = ${id}`
  assert.equal(row.refund_amount, 300000, "500.000 paid against a 200.000 invoice")

  const rows = await getRefunds({ event: EVENT })
  assert.equal(rows.find((r) => r.id === id)!.refundAmount, 300000)
})

test("what has already been sent cannot be parked", async () => {
  const id = await refund("quality", 50000, "refunded")
  await assert.rejects(() => keepRefundOnAccount(id, "tester"), /already been sent/)
})

test("parking it twice is refused rather than silently redone", async () => {
  const id = await refund("quality", 50000)
  await keepRefundOnAccount(id, "tester")
  await assert.rejects(() => keepRefundOnAccount(id, "tester"), /already on her account/)
})

test("nothing owed is nothing to keep", async () => {
  // A goods refund written down to zero, or an overpayment on a settled trip:
  // parking it would put a Rp 0 deposit on her invoice banner.
  const id = await refund("quality", 0)
  await assert.rejects(() => keepRefundOnAccount(id, "tester"), /nothing owed/)
})
