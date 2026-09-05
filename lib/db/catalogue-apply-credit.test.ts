import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { createRefund } from "./finance"
import { applyRefundToOrder } from "./catalogue-refunds"

// shinta.michiko, in miniature: money sitting on a settled trip while a much
// larger one goes unpaid. She can move it herself — nothing leaves the shop's
// account, it is two of her own invoices trading a figure.
const TAG = `applycredit${process.hrtime.bigint()}`
const PAID = `${TAG}_A_SETTLED`
const OWING = `${TAG}_B_OWING`
const WHO = `${TAG}_cust`
const STRANGER = `${TAG}_other`
let productId = 0

async function balance(event: string, who = WHO) {
  const [row] = await sql<{ balance: number }[]>`
    SELECT balance FROM live_balances WHERE event = ${event} AND customer = ${who}`
  return Number(row?.balance ?? 0)
}

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO}), (${STRANGER})`
  for (const e of [PAID, OWING]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
  }

  // Settled trip: ordered 1.000.000, paid 1.300.000 — 300.000 hers.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${PAID}, ${WHO}, ${productId}, 1000000, 1)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${PAID}, ${WHO}, 1300000, true, 'deposit')`

  // Open trip: ordered 2.000.000, paid nothing.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${OWING}, ${WHO}, ${productId}, 2000000, 1)`
})

after(async () => {
  await sql`DELETE FROM payments WHERE customer IN (${WHO}, ${STRANGER})`
  await sql`DELETE FROM refunds WHERE customer IN (${WHO}, ${STRANGER})`
  await sql`DELETE FROM orders WHERE customer IN (${WHO}, ${STRANGER})`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("she moves her credit onto the trip that is short", async () => {
  const { id } = await createRefund({
    event: PAID, customer: WHO, reason: "overpayment", refundAmount: 300000,
  })

  const done = await applyRefundToOrder(id, WHO, OWING)
  assert.equal(done.applied, 300000)

  assert.equal(await balance(PAID), 0, "the settled trip gives the money up")
  assert.equal(await balance(OWING), -1700000, "and the open one is 300.000 less short")

  const [refund] = await sql<{ status: string }[]>`SELECT status FROM refunds WHERE id = ${id}`
  assert.equal(refund.status, "applied_to_next_order")
})

test("the amount is the smaller of what is left and what is owed", async () => {
  // 2.500.000 of credit against a trip 1.700.000 short: it takes 1.700.000 and
  // the rest stays hers. Any other figure overpays the trip into a new refund.
  const { id } = await createRefund({
    event: PAID, customer: WHO, reason: "unavailable", refundAmount: 2500000,
  })

  const done = await applyRefundToOrder(id, WHO, OWING)
  assert.equal(done.applied, 1700000)
  assert.equal(await balance(OWING), 0, "settled exactly, never overpaid")

  const [refund] = await sql<{ amount: number; status: string }[]>`
    SELECT refund_amount::int AS amount, status FROM refunds WHERE id = ${id}`
  assert.equal(refund.amount, 800000, "what she did not spend is still hers")
})

test("a trip with nothing owing is refused", async () => {
  const { id } = await createRefund({
    event: PAID, customer: WHO, reason: "unavailable", refundAmount: 50000,
  })
  await assert.rejects(
    () => applyRefundToOrder(id, WHO, OWING),
    /sisa tagihan/,
    "the open trip was settled by the test above",
  )
})

test("somebody else's refund is not hers to spend", async () => {
  const { id } = await createRefund({
    event: PAID, customer: STRANGER, reason: "unavailable", refundAmount: 100000,
  })
  await assert.rejects(() => applyRefundToOrder(id, WHO, OWING), /tidak ditemukan/)
})

test("money already on its way to a bank cannot be spent twice", async () => {
  const { id } = await createRefund({
    event: PAID, customer: WHO, reason: "unavailable", refundAmount: 100000,
  })
  await sql`UPDATE refunds SET status = 'ready_to_refund' WHERE id = ${id}`
  await assert.rejects(() => applyRefundToOrder(id, WHO, OWING), /sudah diproses/)
})
