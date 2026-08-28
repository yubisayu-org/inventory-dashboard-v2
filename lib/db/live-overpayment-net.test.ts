import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getRefunds, executeRefund, updateRefund } from "./finance"
import { createRefundFromOverpayment } from "./overpayments"
import { refundForReduction, invoiceTotalsNow } from "./mark-refunds"

const TAG = `livenet${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const WHO = `${TAG}_c`
let productId = 0
let orderId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products WHERE COALESCE(gram,0) = 0 ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  // A second trip, so the edit tests cannot collide with the constraint that
  // allows one active overpayment per customer per trip.
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${`${TAG}_EV2`}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
  // Two units at 200.000, and she transferred 500.000 — 100.000 too much.
  const [o] = await sql<{ id: number }[]>`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EVENT}, ${WHO}, ${productId}, 200000, 2) RETURNING id`
  orderId = o.id
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EVENT}, ${WHO}, 500000, true, 'deposit')`
})

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id LIKE ${`${TAG}%`})`
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM refunds WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("an overpayment refund is the balance less what other open refunds claim", async () => {
  // The order that drifts. The overpayment is filed first, from a transfer
  // typed wrong; the mark comes afterwards. Her balance then counts the goods
  // twice -- once as the surplus the mark created, once as the goods refund --
  // and paying both sends 160.000 that is not owed.
  const { amount } = await createRefundFromOverpayment(EVENT, WHO, "tester")
  assert.equal(amount, 100000, "the transfer error, and only that")

  const totalsBefore = await invoiceTotalsNow(EVENT)
  await sql`UPDATE orders SET unit = 1 WHERE id = ${orderId}`
  const goods = await refundForReduction(EVENT, "unavailable", "Test Item", [
    { customer: WHO, unitsRemoved: 1, unitPrice: 200000, gramPerUnit: 0 },
  ], totalsBefore, "tester")
  assert.equal(goods[0].amount, 200000, "the unit she is not getting")

  const rows = await getRefunds({ event: EVENT })
  const over = rows.find((r) => r.reason === "overpayment")!
  assert.equal(
    over.refundAmount, 100000,
    "her balance is 300.000, but 200.000 of it is the goods refund's",
  )
  assert.equal(
    rows.reduce((n, r) => n + r.refundAmount, 0), 300000,
    "and the two together come to exactly what she is overpaid",
  )
})

test("the transfer pays the net figure, not the raw balance", async () => {
  const rows = await getRefunds({ event: EVENT })
  const over = rows.find((r) => r.reason === "overpayment")!
  await executeRefund(over.id, "REF-1", "BCA", "tester")

  const [paid] = await sql<{ amount: number }[]>`
    SELECT amount::int FROM payments WHERE refund_id = ${over.id}`
  assert.equal(paid.amount, -100000)
  const [frozen] = await sql<{ refund_amount: number }[]>`
    SELECT refund_amount::int FROM refunds WHERE id = ${over.id}`
  assert.equal(frozen.refund_amount, 100000, "frozen at what left the bank")
})

test("a refund already paid stops claiming anything", async () => {
  // The goods refund is still open, so it still holds its 200.000 back. Once it
  // is transferred the payment row lowers her balance instead, and subtracting
  // it a second time would hide money she is genuinely owed.
  const goods = (await getRefunds({ event: EVENT })).find((r) => r.reason === "unavailable")!
  await executeRefund(goods.id, "REF-2", "BCA", "tester")
  const [{ balance }] = await sql<{ balance: number }[]>`
    SELECT balance::int FROM live_balances
     WHERE event = ${EVENT} AND customer = ${WHO}`
  assert.equal(balance, 0, "500.000 in, 200.000 invoice, 300.000 sent back")
})

test("no refund's amount can be typed over, whatever kind it is", async () => {
  // Every amount is computed or typed once, when the refund is made. Editing
  // afterwards made a fourth kind of figure -- no reasoning attached, nothing
  // to check it against. A wrong refund is cancelled and made again, which
  // leaves a record instead of quietly replacing the number.
  const kinds: [string, number][] = [["overpayment", 1], ["quality", 160000], ["unavailable", 50000]]
  for (const [reason, amount] of kinds) {
    const [r] = await sql<{ id: number }[]>`
      INSERT INTO refunds (event, customer, reason, refund_amount, status)
      VALUES (${`${TAG}_EV2`}, ${WHO}, ${reason}, ${amount}, 'pending') RETURNING id`
    await assert.rejects(
      // @ts-expect-error -- the field is typed `never`; this is the runtime guard
      () => updateRefund(r.id, { refundAmount: 999999 }),
      /set when it is made/,
      reason,
    )
    // The note is hers to write at any stage, and always was.
    await updateRefund(r.id, { note: "asked her on WhatsApp" })
    const [row] = await sql<{ note: string; refund_amount: number }[]>`
      SELECT note, refund_amount::int FROM refunds WHERE id = ${r.id}`
    assert.equal(row.note, "asked her on WhatsApp")
    assert.equal(row.refund_amount, amount, `${reason} keeps its own figure`)
  }
})
