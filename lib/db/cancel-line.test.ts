import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { cancelOrderLineForCustomer } from "./cancel-line"
import { getRefunds } from "./finance"

const TAG = `cancelline${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const PAID = `${TAG}_paid`
const UNPAID = `${TAG}_unpaid`
let productId = 0

async function line(customer: string, unit = 2, shipped = 0) {
  const [o] = await sql<{ id: number }[]>`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_ship)
    VALUES (${EVENT}, ${customer}, ${productId}, 100000, ${unit}, ${unit}, ${shipped})
    RETURNING id`
  return o.id
}

async function notices(customer: string) {
  return await sql<{ title: string; body: string }[]>`
    SELECT an.title, an.body FROM announcements an
      JOIN customers c ON c.id = an.customer_id
     WHERE c.instagram_id = ${customer} ORDER BY an.id`
}

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products WHERE COALESCE(gram,0) = 0 ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  for (const who of [PAID, UNPAID]) await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
})

after(async () => {
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

test("a cancellation she has paid for files its own refund", async () => {
  // The whole point of the change. It used to stop at the order and leave the
  // surplus sitting on the Refunds page for somebody to notice.
  const id = await line(PAID)
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EVENT}, ${PAID}, 200000, true, 'deposit')`

  const { refunds } = await cancelOrderLineForCustomer(
    { orderId: id, qty: 1, event: EVENT, productName: "Bucket Hat" }, "tester")

  assert.equal(refunds.length, 1)
  assert.equal(refunds[0].amount, 100000, "one unit of the two she paid for")
  const [row] = await getRefunds({ event: EVENT })
  assert.equal(row.reason, "customer_cancelled")
  assert.equal(row.refundAmount, 100000)
})

test("she is told once, and the refund is what tells her", async () => {
  // Two notices for one event -- "this came off" then "here is your money" --
  // is the shop talking to itself. The refund's notice already names both.
  const sent = await notices(PAID)
  assert.equal(sent.length, 1, "one message about it")
  assert.match(sent[0].body, /Bucket Hat/)
  assert.match(sent[0].body, /100\.000/)
})

test("nothing paid means no refund, and she still hears about it", async () => {
  // An unpaid order simply costs less. Inventing a refund there would invent a
  // debt -- but the line vanishing from her order is still news.
  const id = await line(UNPAID)
  const { refunds } = await cancelOrderLineForCustomer(
    { orderId: id, qty: 2, event: EVENT, productName: "Muji Diffuser" }, "tester")

  assert.equal(refunds.length, 0)
  const sent = await notices(UNPAID)
  assert.equal(sent.length, 1)
  assert.match(sent[0].body, /Muji Diffuser × 2/)
  assert.match(sent[0].body, /200\.000/, "what her bill goes down by")
})

test("a shipped line is refused before anything moves", async () => {
  const id = await line(PAID, 2, 1)
  const before = (await notices(PAID)).length
  await assert.rejects(
    () => cancelOrderLineForCustomer(
      { orderId: id, qty: 2, event: EVENT, productName: "Gone Already" }, "tester"),
    /already shipped/,
  )
  const [row] = await sql<{ unit: number }[]>`SELECT unit FROM orders WHERE id = ${id}`
  assert.equal(row.unit, 2, "the line is untouched")
  assert.equal((await notices(PAID)).length, before, "and she was told nothing")
})
