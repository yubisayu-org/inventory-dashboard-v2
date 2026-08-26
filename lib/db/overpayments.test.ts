import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { materializeOverpaymentRefunds, getRefunds } from "./finance"
import { listOverpaymentsToCheck, createRefundFromOverpayment } from "./overpayments"

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

test("an uncovered overpayment appears in the list", async () => {
  // The reconcile test above added a negative-price line to stand in for a
  // mark's reduction. Remove it so the gap is the plain 50_000 again.
  await sql`DELETE FROM orders WHERE event = ${EVENT} AND unit_price < 0`
  await sql`DELETE FROM refunds WHERE event = ${EVENT}`
  const rows = await listOverpaymentsToCheck()
  const mine = rows.find((r) => r.event === EVENT && r.customer === HANDLE)
  assert.ok(mine, "the pair must be listed")
  assert.equal(mine.uncovered, 50000)
  assert.equal(mine.totalPaid, 550000)
})

test("a refund covering it removes it from the list", async () => {
  await sql`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EVENT}, ${HANDLE}, 'overpayment', 50000, 'pending')`
  const rows = await listOverpaymentsToCheck()
  assert.equal(rows.find((r) => r.event === EVENT && r.customer === HANDLE), undefined)
  await sql`DELETE FROM refunds WHERE event = ${EVENT}`
})

test("creating a refund from a row clears it and lands in Pending", async () => {
  const made = await createRefundFromOverpayment(EVENT, HANDLE, "tester")
  assert.equal(made.amount, 50000)

  const [row] = await sql<{ reason: string; status: string; refund_amount: number }[]>`
    SELECT reason, status, refund_amount FROM refunds WHERE id = ${made.id}`
  assert.equal(row.reason, "overpayment")
  assert.equal(row.status, "pending")
  assert.equal(row.refund_amount, 50000)

  const rows = await listOverpaymentsToCheck()
  assert.equal(rows.find((r) => r.event === EVENT && r.customer === HANDLE), undefined)
  await sql`DELETE FROM refunds WHERE event = ${EVENT}`
})

test("creating a refund when nothing is uncovered is refused", async () => {
  await sql`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${EVENT}, ${HANDLE}, 'overpayment', 50000, 'pending')`
  await assert.rejects(() => createRefundFromOverpayment(EVENT, HANDLE, "tester"))
  await sql`DELETE FROM refunds WHERE event = ${EVENT}`
})

test("a refund covers its customer when the handle was stored with capitals", async () => {
  // getPaymentStatus emits the normalized handle; refunds.customer holds the
  // stored spelling, which the FK ties to customers.instagram_id. Keying the
  // join on the raw value matches nothing whenever that spelling is not already
  // lower case — and the failure is silent and points the wrong way: a covered
  // overpayment looks uncovered, and the same money gets refunded twice.
  const CAPS = `${TAG}_Mixed_Case`
  const CAPS_EVENT = `${TAG}_EV2`
  await sql`INSERT INTO customers (instagram_id) VALUES (${CAPS})`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${CAPS_EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${CAPS_EVENT}, ${CAPS}, ${productId}, 100000, 1)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${CAPS_EVENT}, ${CAPS}, 130000, true, 'deposit')`

  const before = await listOverpaymentsToCheck()
  assert.ok(before.find((r) => r.event === CAPS_EVENT), "30_000 uncovered to begin with")

  await sql`
    INSERT INTO refunds (event, customer, reason, refund_amount, status)
    VALUES (${CAPS_EVENT}, ${CAPS}, 'overpayment', 30000, 'pending')`

  const after = await listOverpaymentsToCheck()
  assert.equal(after.find((r) => r.event === CAPS_EVENT), undefined,
    "the refund covers it despite the capitals")

  await sql`DELETE FROM refunds WHERE event = ${CAPS_EVENT}`
  await sql`DELETE FROM payments WHERE event = ${CAPS_EVENT}`
  await sql`DELETE FROM orders WHERE event = ${CAPS_EVENT}`
  await sql`DELETE FROM events WHERE name = ${CAPS_EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id = ${CAPS}`
})
