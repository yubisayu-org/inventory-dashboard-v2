import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import {
  getShipOrdersFiltered,
  reapplyHoldsForArrival,
  shipCustomerOrders,
  PairedShipmentError,
} from "./fulfillment"
import { setMergeGroup } from "./shipping-prefs"

// A pairing whose other half has nothing left to send is not a pairing.
//
// LSCN202606, Nov 2026: eight customers had a trip paired with another, and
// the other went out (or was cancelled to nothing) while a late Man Underwear
// Set was still on its way. When the set landed, the pairing parked it; the
// card read "paired"; and the Gabung tab, which only shows a pair of two or
// more, left it out -- so did Hold and Ready, which leave paired cards to
// Gabung. Paid-for stock sat in the warehouse on no tab at all until somebody
// asked why a customer could not be shipped.
const TAG = `spent${process.hrtime.bigint()}`
const PARTNER = `${TAG}_PARTNER`
const LATE = `${TAG}_LATE`
const WHO = `${TAG}_cust`
let customerId = 0
let productId = 0
let lateRow = 0

async function card(event: string) {
  const { groups } = await getShipOrdersFiltered({ segment: "all", search: WHO })
  return groups.find((g) => g.event === event) ?? null
}

async function hold(event: string): Promise<number> {
  const [r] = await sql<{ h: number }[]>`
    SELECT COALESCE(SUM(unit_hold), 0)::int AS h FROM orders WHERE event = ${event} AND customer = ${WHO}`
  return r.h
}

before(async () => {
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${WHO}) RETURNING id`
  customerId = c.id
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  productId = p.id
  for (const e of [PARTNER, LATE]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
  }
  // The partner has landed; the late trip's one unit has not.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive)
    VALUES (${PARTNER}, ${WHO}, ${productId}, 100000, 1, 1, 1, 1)`
  const [late] = await sql<{ id: number }[]>`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch)
    VALUES (${LATE}, ${WHO}, ${productId}, 100000, 1, 1, 1) RETURNING id`
  lateRow = late.id
  // Pairing is refused on an unpaid trip, so both are settled first.
  for (const e of [PARTNER, LATE]) {
    await sql`
      INSERT INTO payments (event, customer, amount, is_checked, kind)
      VALUES (${e}, ${WHO}, 100000, true, 'deposit')`
  }
  await setMergeGroup(customerId, [PARTNER, LATE], sql, "shop")
})

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM adjustments WHERE customer = ${WHO}`
  await sql`DELETE FROM shipments WHERE customer = ${WHO}`
  await sql`DELETE FROM payments WHERE customer = ${WHO}`
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM orders WHERE customer = ${WHO}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE id = ${customerId}`
  await sql.end()
})

test("while the partner still has something to send, the pair holds", async () => {
  // The design this must not break: a pair waits for its slowest member.
  const late = await card(LATE)
  assert.ok(late)
  assert.equal(late.status, "paired")
})

test("once the partner has gone, a late arrival is not parked for it", async () => {
  // The partner leaves on its own; the late unit is still in transit.
  await sql`UPDATE orders SET unit_ship = 1, unit_hold = 0 WHERE event = ${PARTNER} AND customer = ${WHO}`
  await sql`UPDATE orders SET unit_hold = 0 WHERE id = ${lateRow}`

  // Then it lands, and the arrival re-applies whatever is meant to park it.
  await sql`UPDATE orders SET unit_arrive = 1 WHERE id = ${lateRow}`
  await reapplyHoldsForArrival(LATE, [WHO])

  assert.equal(await hold(LATE), 0, "nothing is left to wait for, so nothing should park it")
})

test("and its card is an ordinary card, on a tab somebody looks at", async () => {
  const late = await card(LATE)
  assert.ok(late)
  assert.notEqual(late.status, "paired", "a pair of one is shown nowhere")
  assert.equal(late.status, "ready")
})

test("and it can be shipped without being told it is paired", async () => {
  // The single-ship guard reads the same pairing; a spent partner must not
  // trip it, or every one of these would need "ship anyway".
  await assert.doesNotReject(
    shipCustomerOrders({
      customer: WHO,
      event: LATE,
      orders: [{ rowNumber: lateRow, productId, productName: "x", toShip: 1, unitShip: 0 }],
      weightKg: 1,
      ongkirPerKg: 10000,
    }, "tester"),
    (e: unknown) => e instanceof PairedShipmentError,
  )
  // Put it back for the next test.
  await sql`DELETE FROM shipments WHERE customer = ${WHO} AND event = ${LATE}`
  await sql`UPDATE orders SET unit_ship = NULL WHERE id = ${lateRow}`
})

test("a partner cancelled to nothing counts as gone too", async () => {
  // nomidmk's case: the other half was not shipped but marked out of stock.
  await sql`UPDATE orders SET unit_ship = NULL, unit = 0, unit_buy = 0, unit_dispatch = 0, unit_arrive = 0
             WHERE event = ${PARTNER} AND customer = ${WHO}`
  await sql`UPDATE orders SET unit_hold = 0 WHERE id = ${lateRow}`
  await reapplyHoldsForArrival(LATE, [WHO])
  assert.equal(await hold(LATE), 0)

  const late = await card(LATE)
  assert.ok(late)
  assert.notEqual(late.status, "paired")
})
