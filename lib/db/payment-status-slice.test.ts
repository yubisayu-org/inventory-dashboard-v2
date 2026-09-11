import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getPaymentStatus } from "./finance"
import { outstandingElsewhere, outstandingByCustomer } from "./outstanding-elsewhere"

/**
 * Asking for a slice must answer exactly what filtering the whole would.
 *
 * The gate is a WHERE over the figures the query itself computed, so it cannot
 * hold a second copy of the invoice rule -- but it can still be wired to the
 * wrong comparison, and that would quietly hide money owed. So the slices are
 * checked against the unfiltered answer.
 */
const TAG = `slice${process.hrtime.bigint()}`
const OWES = `${TAG}_owes`
const SQUARE = `${TAG}_square`
const OVER = `${TAG}_over`
const EV1 = `${TAG}_EV1`
const EV2 = `${TAG}_EV2`

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    SELECT id FROM products WHERE COALESCE(gram, 0) = 0 ORDER BY id LIMIT 1`
  for (const e of [EV1, EV2]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
  }
  for (const who of [OWES, SQUARE, OVER]) {
    await sql`INSERT INTO customers (instagram_id) VALUES (${who})`
    await sql`
      INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
      SELECT c.id, w.id, 0 FROM customers c CROSS JOIN warehouses w
       WHERE c.instagram_id = ${who} ON CONFLICT (customer_id, warehouse_id) DO NOTHING`
  }
  // One owing on two trips, one settled exactly, one who paid too much.
  for (const e of [EV1, EV2]) {
    await sql`INSERT INTO orders (event, customer, product_id, unit_price, unit)
              VALUES (${e}, ${OWES}, ${p.id}, 100000, 1)`
  }
  await sql`INSERT INTO orders (event, customer, product_id, unit_price, unit)
            VALUES (${EV1}, ${SQUARE}, ${p.id}, 100000, 1)`
  // Only a checked payment counts towards an invoice, which is the shop's rule.
  await sql`INSERT INTO payments (event, customer, amount, account, pay_date, is_checked)
            VALUES (${EV1}, ${SQUARE}, 100000, 'BCA', CURRENT_DATE, true)`
  await sql`INSERT INTO orders (event, customer, product_id, unit_price, unit)
            VALUES (${EV1}, ${OVER}, ${p.id}, 100000, 1)`
  await sql`INSERT INTO payments (event, customer, amount, account, pay_date, is_checked)
            VALUES (${EV1}, ${OVER}, 150000, 'BCA', CURRENT_DATE, true)`
})

after(async () => {
  await sql`DELETE FROM payments WHERE event IN (${EV1}, ${EV2})`
  await sql`DELETE FROM orders WHERE event IN (${EV1}, ${EV2})`
  await sql`DELETE FROM events WHERE name IN (${EV1}, ${EV2})`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id LIKE ${`${TAG}%`})`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

const mine = (rows: { customer: string }[]) => rows.filter((r) => r.customer.startsWith(TAG.toLowerCase()))
const key = (r: { event: string; customer: string }) => `${r.event}|${r.customer}`

test("the outstanding slice is the whole ledger filtered, and nothing else", async () => {
  const whole = await getPaymentStatus()
  const sliced = await getPaymentStatus(undefined, { only: "outstanding" })

  const expected = whole.filter((r) => r.outstanding > 0).map(key).sort()
  assert.deepEqual(sliced.map(key).sort(), expected)
  assert.ok(expected.length < whole.length, "and it is a slice, not the lot")

  // The fixture's own rows, as a legible check on the above.
  assert.equal(mine(sliced).length, 2, "both of her unpaid trips")
  assert.ok(!mine(sliced).some((r) => r.customer === SQUARE), "the settled one is gone")
})

test("the overpaid slice is the mirror of it", async () => {
  const whole = await getPaymentStatus()
  const sliced = await getPaymentStatus(undefined, { only: "overpaid" })

  assert.deepEqual(
    sliced.map(key).sort(),
    whole.filter((r) => r.totalPaid > r.invoiceTotal).map(key).sort(),
  )
  assert.ok(mine(sliced).some((r) => r.customer === OVER), "the one who paid too much")
})

test("one customer's rows are the same rows, fetched alone", async () => {
  const whole = await getPaymentStatus()
  const hers = await getPaymentStatus(undefined, { customer: OWES })

  assert.deepEqual(
    hers.map(key).sort(),
    whole.filter((r) => r.customer === OWES).map(key).sort(),
  )
  assert.equal(hers.length, 2)
})

test("the callers still answer what they answered before", async () => {
  const elsewhere = await outstandingElsewhere(OWES, EV1)
  assert.deepEqual(elsewhere.map((t) => t.event), [EV2], "the trip being refunded is excluded")
  assert.equal(elsewhere[0].amount, 100000)

  const byCustomer = await outstandingByCustomer()
  assert.equal(byCustomer[OWES]?.length, 2)
  assert.equal(byCustomer[SQUARE], undefined, "nothing owed, no entry")
})
