import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { refundForReduction, invoiceTotalsNow } from "./mark-refunds"
import { getRefunds } from "./finance"
import { markProductOutOfStock } from "./shopping-list"
import { recordNotReceived } from "./fulfillment"

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
  // Products only after the orders that point at them, and the ongkir rows
  // only before the customers they hang off.
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id LIKE ${`${TAG}%`})`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("only the customer who paid is refunded", async () => {
  // Snapshot first: the refund is capped by how far each invoice falls.
  const before = await invoiceTotalsNow(EVENT)
  // Both orders shrink to zero. The unpaid one simply owes less.
  await sql`UPDATE orders SET unit = 0 WHERE event = ${EVENT}`
  const made = await refundForReduction(EVENT, "unavailable", "Test Product", [
    { customer: PAID, unitsRemoved: 1, unitPrice: 100000, gramPerUnit: 0 },
    { customer: UNPAID, unitsRemoved: 1, unitPrice: 100000, gramPerUnit: 0 },
  ], before, "tester")

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

test("picking whose order it comes off still removes only the marked quantity", async () => {
  // The Arrival List has two ways to mark the same thing: name a quantity, or
  // pick whose orders it comes off. The picking one used to cancel each chosen
  // line whole — so marking one unit broken on a two-unit order took both,
  // refunded both, and left the surviving unit on no order and in no
  // inventory. It was bought and it was fine, and it was simply gone.
  const who = `${TAG}_picked`
  await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
  const [order] = await sql<{ id: number }[]>`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive)
    VALUES (${EVENT}, ${who}, ${productId}, 250000, 2, 2, 2, 0) RETURNING id`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EVENT}, ${who}, 500000, true, 'deposit')`

  const result = await recordNotReceived({
    event: EVENT, productId, productName: "Anything", qty: 1, mode: "broken", orderIds: [order.id],
  })

  assert.equal(result.cancelledUnits, 1, "one unit marked, one unit removed")
  assert.equal(result.refunds.length, 1)
  assert.equal(result.refunds[0].amount, 250000, "refunded for one unit, not the line")

  const [left] = await sql<{ unit: number }[]>`SELECT unit FROM orders WHERE id = ${order.id}`
  assert.equal(left.unit, 1, "she still gets the one that was fine")
})

test("the filter narrows the candidates without changing the rule", async () => {
  // Two customers waiting on the same product; only one is picked. The other
  // must be untouched however priority would otherwise have ordered them.
  const picked = `${TAG}_a`
  const spared = `${TAG}_b`
  const ids: Record<string, number> = {}
  for (const who of [picked, spared]) {
    await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
    const [o] = await sql<{ id: number }[]>`
      INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive)
      VALUES (${EVENT}, ${who}, ${productId}, 80000, 1, 1, 1, 0) RETURNING id`
    ids[who] = o.id
  }

  await recordNotReceived({
    event: EVENT, productId, productName: "Anything", qty: 1, mode: "missing", orderIds: [ids[picked]],
  })

  const [a] = await sql<{ unit: number }[]>`SELECT unit FROM orders WHERE id = ${ids[picked]}`
  const [b] = await sql<{ unit: number }[]>`SELECT unit FROM orders WHERE id = ${ids[spared]}`
  assert.equal(a.unit, 0)
  assert.equal(b.unit, 1, "an order nobody picked keeps its units")
})

test("the ongkir the missing goods were carrying comes back with them", async () => {
  // The bug this replaced: the refund was the price of the goods, full stop.
  // Her invoice bills ongkir on weight it no longer carries, so the difference
  // sat behind as an overpayment for somebody to find in To check -- and the
  // notice told her a smaller number than she was actually owed.
  const EV = `${TAG}_KG`
  const who = `${TAG}_kg_paid`
  const RATE = 25_000

  // A 1 kg product, so removing one unit removes exactly one billed kilo.
  const [heavy] = await sql<{ id: number }[]>`
    INSERT INTO products (name, gram, price)
    VALUES (${`${TAG} Heavy Thing`}, 1000, 300000) RETURNING id`
  const [wh] = await sql<{ id: number }[]>`SELECT id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO events (name, warehouse_id) VALUES (${EV}, ${wh.id})`
  const [cust] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${who}) RETURNING id`
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
    VALUES (${cust.id}, ${wh.id}, ${RATE})
    ON CONFLICT (customer_id, warehouse_id) DO UPDATE SET ongkos_kirim = ${RATE}`

  // Four units at 300_000 = 1_200_000 of goods, 4 kg of ongkir = 100_000.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch)
    VALUES (${EV}, ${who}, ${heavy.id}, 300000, 4, 4, 4)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${who}, ${1_200_000 + 4 * RATE}, true, 'deposit')`

  const result = await recordNotReceived(
    { event: EV, productId: heavy.id, productName: `${TAG} Heavy Thing`, qty: 1, mode: "missing" },
    "tester",
  )

  assert.equal(result.refunds.length, 1)
  assert.equal(
    result.refunds[0].amount,
    300_000 + RATE,
    "the goods and the kilo they occupied, in one refund",
  )

  // And nothing left over pretending to be an overpayment.
  const [status] = await sql<{ invoice_total: number; total_paid: number }[]>`
    SELECT (SUM(o.unit_price * o.unit) + ${RATE} * CEIL(SUM(COALESCE(p.gram,0) * o.unit)::numeric / 1000))::int
             AS invoice_total,
           (SELECT COALESCE(SUM(amount),0)::int FROM payments
             WHERE event = ${EV} AND is_checked) AS total_paid
      FROM orders o JOIN products p ON p.id = o.product_id
     WHERE o.event = ${EV}`
  assert.equal(
    status.total_paid - status.invoice_total,
    result.refunds[0].amount,
    "the refund is the whole surplus -- no stray kilo waiting in To check",
  )
})

test("the note says what came off, how many, and what each cost", async () => {
  // The note is the only record of a refund's goods -- the order line it came
  // from is already reduced -- so a figure with nothing to check it against is
  // a figure nobody trusts six weeks later.
  const who = `${TAG}_priced`
  const EV = `${TAG}_PRICED`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EV}, ${who}, ${productId}, 100000, 2)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${who}, 200000, true, 'deposit')`

  const before = await invoiceTotalsNow(EV)
  await sql`UPDATE orders SET unit = 0 WHERE event = ${EV}`
  await refundForReduction(EV, "unavailable", "Muji Boston Bag 38L Greige", [
    { customer: who, unitsRemoved: 2, unitPrice: 100000, gramPerUnit: 0 },
  ], before, "tester")

  const [row] = await sql<{ note: string }[]>`
    SELECT note FROM refunds WHERE event = ${EV}`
  assert.equal(row.note, "Muji Boston Bag 38L Greige × 2 × Rp 100.000 = Rp 200.000")
})

test("a single unit does not print a sum of one thing", async () => {
  const who = `${TAG}_one`
  const EV = `${TAG}_ONE`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EV}, ${who}, ${productId}, 160000, 1)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EV}, ${who}, 160000, true, 'deposit')`

  const before = await invoiceTotalsNow(EV)
  await sql`UPDATE orders SET unit = 0 WHERE event = ${EV}`
  await refundForReduction(EV, "damaged", "Muji Bucket Hat with String", [
    { customer: who, unitsRemoved: 1, unitPrice: 160000, gramPerUnit: 0 },
  ], before, "tester")

  const [row] = await sql<{ note: string }[]>`SELECT note FROM refunds WHERE event = ${EV}`
  assert.equal(row.note, "Muji Bucket Hat with String × 1 × Rp 160.000")
})
