import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { refundForReduction, snapshotReductions } from "./mark-refunds"
import { getRefunds } from "./finance"
import { markProductOutOfStock } from "./shopping-list"
import { recordNotReceived } from "./fulfillment"
import { recordBrokenArrival } from "./orders"

const TAG = `marktest${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const PAID = `${TAG}_paid`
const UNPAID = `${TAG}_unpaid`
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products WHERE COALESCE(gram,0) = 0 ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  for (const who of [PAID, UNPAID]) {
    await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit)
      VALUES (${EVENT}, ${who}, ${productId}, 100000, 1)`
  }
  // Only one of them has transferred anything.
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EVENT}, ${PAID}, 100000, true, 'deposit')`
})

after(async () => {
  // announcements is keyed by customer_id, not by event.
  await sql`DELETE FROM announcements WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id LIKE ${`${TAG}%`})`
  await sql`DELETE FROM refunds WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM excess_purchase WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("only the customer who paid is refunded", async () => {
  // Both orders shrink to zero. The unpaid one simply owes less.
  await sql`UPDATE orders SET unit = 0 WHERE event = ${EVENT}`
  const made = await refundForReduction(EVENT, "unavailable", "Test Product", [
    { customer: PAID, unitsRemoved: 1, unitPrice: 100000 },
    { customer: UNPAID, unitsRemoved: 1, unitPrice: 100000 },
  ], "tester")

  assert.equal(made.length, 1, "one refund, not two")
  assert.equal(made[0].amount, 100000)

  const rows = await getRefunds({ event: EVENT })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].reason, "unavailable")
  assert.equal(rows[0].status, "pending")
})

test("the customer is told, in the same breath", async () => {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM announcements
     WHERE customer_id IN (SELECT id FROM customers WHERE instagram_id = ${PAID})`
  assert.ok(Number(rows[0].n) >= 1, "a refund nobody is told about is a promise nobody made")
})

test("marking sold out refunds the customer who paid", async () => {
  const EV = `${TAG}_SOLD`
  const who = `${TAG}_sold_paid`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EV}, ${who}, ${productId}, 100000, 2)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${who}, 200000, true, 'deposit')`

  const result = await markProductOutOfStock(
    { event: EV, productId, quantityOutOfStock: 1 }, "tester")

  assert.equal(result.reducedUnits, 1)
  assert.equal(result.refunds.length, 1)
  assert.equal(result.refunds[0].amount, 100000)

  const rows = await getRefunds({ event: EV })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].reason, "unavailable")
})

test("a missing parcel refunds the customer who paid, as shipping_loss", async () => {
  const EV = `${TAG}_MISS`
  const who = `${TAG}_miss_paid`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch)
    VALUES (${EV}, ${who}, ${productId}, 100000, 2, 2, 2)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${who}, 200000, true, 'deposit')`

  const [prod] = await sql<{ name: string }[]>`SELECT name FROM products WHERE id = ${productId}`
  const result = await recordNotReceived(
    { event: EV, productId, productName: prod.name, qty: 1, mode: "missing" }, "tester")

  assert.equal(result.refunds.length, 1)
  assert.equal(result.refunds[0].amount, 100000)
  const rows = await getRefunds({ event: EV })
  assert.equal(rows[0].reason, "shipping_loss")
})

test("a customer cancellation creates no refund here", async () => {
  // Their own doing, and the cancellation flow already handles it.
  const EV = `${TAG}_CANC`
  const who = `${TAG}_canc_paid`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch)
    VALUES (${EV}, ${who}, ${productId}, 100000, 2, 2, 2)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${who}, 200000, true, 'deposit')`

  const [prod] = await sql<{ name: string }[]>`SELECT name FROM products WHERE id = ${productId}`
  const result = await recordNotReceived(
    { event: EV, productId, productName: prod.name, qty: 1, mode: "cancelled" }, "tester")

  assert.equal(result.refunds.length, 0)
  assert.equal((await getRefunds({ event: EV })).length, 0)
})

test("the pick-which-customer flow refunds too, not only the quantity one", async () => {
  // The Arrival List has two ways to mark the same thing: one takes a quantity
  // and allocates it, the other lets staff choose whose orders go. Only the
  // first created refunds, so a mark made the second way reduced the order,
  // told nobody, and left the money to surface as an unexplained overpayment.
  const who = `${TAG}_picked`
  await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
  const [order] = await sql<{ id: number }[]>`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EVENT}, ${who}, ${productId}, 250000, 2) RETURNING id`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EVENT}, ${who}, 500000, true, 'deposit')`

  // Exactly the order the route follows: read what is about to go, cancel it,
  // then price the refund against the invoice as it then stands.
  const reductions = await snapshotReductions([order.id])
  assert.deepEqual(reductions, [{ customer: who, unitsRemoved: 2, unitPrice: 250000 }])

  await recordBrokenArrival({ event: EVENT, productName: "Anything", qty: 2, cancelOrderIds: [order.id] })
  const refunds = await refundForReduction(EVENT, "damaged", "Anything", reductions, null)

  assert.equal(refunds.length, 1)
  assert.equal(refunds[0].amount, 500000)
  const rows = await getRefunds()
  const mine = rows.find((r) => r.customer === who)
  assert.equal(mine?.reason, "damaged")
})

test("a snapshot taken after the units are gone finds nothing to refund", async () => {
  // Which is why it is taken first. Guards the ordering, not the arithmetic.
  const who = `${TAG}_late`
  await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
  const [order] = await sql<{ id: number }[]>`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EVENT}, ${who}, ${productId}, 90000, 1) RETURNING id`
  await recordBrokenArrival({ event: EVENT, productName: "Anything", qty: 1, cancelOrderIds: [order.id] })
  assert.deepEqual(await snapshotReductions([order.id]), [])
})
