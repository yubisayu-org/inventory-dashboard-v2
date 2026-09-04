import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { recordReturnedUnits } from "./return-line"
import { getPaymentStatus } from "./finance"

// Goods that come back stop being billed — and take their delivery with them.
// Before this, a quality refund moved money while the invoice went on charging
// for the item, so paying the refund out left her owing for something sitting
// on the shop's shelf.

const TAG = `retn${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`

let customerId = 0
let handle = ""
let orderId = 0
let unitPrice = 0

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM refunds WHERE event = ${EVENT}`
  await sql`DELETE FROM adjustments WHERE event = ${EVENT}`
  await sql`DELETE FROM excess_purchase WHERE event = ${EVENT}`
  await sql`DELETE FROM payments WHERE event = ${EVENT}`
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ${customerId}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

async function seed() {
  handle = `${TAG}_cust`
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${handle}) RETURNING id`
  customerId = c.id

  const [w] = await sql<{ id: number }[]>`SELECT id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO events (name, warehouse_id) VALUES (${EVENT}, ${w.id})`
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
    VALUES (${customerId}, ${w.id}, 25000)`

  const [p] = await sql<{ id: number; gram: number }[]>`
    SELECT id, COALESCE(gram, 0) AS gram FROM products WHERE COALESCE(gram, 0) > 0 ORDER BY id LIMIT 1`
  unitPrice = 830000
  const [o] = await sql<{ id: number }[]>`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_arrive, unit_ship)
    VALUES (${EVENT}, ${handle}, ${p.id}, ${unitPrice}, 2, 2, 2, 2)
    RETURNING id`
  orderId = o.id
}

async function invoiceTotal(): Promise<number> {
  const rows = await getPaymentStatus(EVENT)
  return rows.find((r) => r.customer.includes(TAG.toLowerCase()))?.invoiceTotal ?? 0
}

test("a returned unit stops being billed, and its delivery comes back with it", async () => {
  await seed()
  const before = await invoiceTotal()
  assert.ok(before > 0, "she is billed for two units and their ongkir")

  const refunds = await recordReturnedUnits({
    event: EVENT, customer: handle, reason: "quality", goods: "returned_unsellable",
    lines: [{ orderId, qty: 1 }],
  })

  const after = await invoiceTotal()
  assert.ok(after < before, "the invoice fell")
  assert.ok(before - after >= unitPrice, "by at least the goods — the ongkir it carried is on top")

  // She had not paid, so there is nothing to give back: a refund here would
  // invent a debt. The smaller bill is the whole of it.
  assert.deepEqual(refunds, [])

  const [line] = await sql<{ unit: number; unit_returned: number; unit_ship: number }[]>`
    SELECT unit, unit_returned, unit_ship FROM orders WHERE id = ${orderId}`
  assert.equal(line.unit, 2, "she did buy two, and the line still says so")
  assert.equal(line.unit_returned, 1)
  assert.equal(line.unit_ship, 2, "and the parcel really did carry two")

  const [stock] = await sql<{ reason: string; unit_buy: number }[]>`
    SELECT reason, unit_buy FROM excess_purchase WHERE event = ${EVENT}`
  assert.equal(stock.reason, "returned_unsellable")
  assert.equal(stock.unit_buy, 1, "a unit no order claims any more")
})

test("a customer who has paid is refunded what her bill actually fell by", async () => {
  const owed = await invoiceTotal()
  await sql`
    INSERT INTO payments (event, customer, amount, account, is_checked, kind)
    VALUES (${EVENT}, ${handle}, ${owed}, 'BCA', true, 'deposit')`

  const before = await invoiceTotal()
  const refunds = await recordReturnedUnits({
    event: EVENT, customer: handle, reason: "quality", goods: "returned",
    lines: [{ orderId, qty: 1 }],
  })
  const after = await invoiceTotal()

  assert.equal(refunds.length, 1, "she paid, so the surplus is owed back")
  assert.equal(refunds[0].amount, before - after, "exactly what her bill fell by, ongkir included")

  // Which is the point of the whole change: paying that refund out leaves her
  // at zero rather than owing for goods she sent back.
  const [{ n }] = await sql<{ n: string }[]>`
    SELECT COALESCE(SUM(amount), 0) AS n FROM payments
     WHERE event = ${EVENT} AND is_checked AND kind = 'deposit'`
  assert.equal(Number(n) - after, refunds[0].amount, "the overpayment equals the refund")
})

test("she cannot send back more than she has", async () => {
  await assert.rejects(
    () => recordReturnedUnits({
      event: EVENT, customer: handle, reason: "quality", goods: "returned",
      lines: [{ orderId, qty: 5 }],
    }),
    /can still be returned/,
  )
})
