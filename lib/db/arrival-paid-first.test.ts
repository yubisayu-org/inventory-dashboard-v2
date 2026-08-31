import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { markProductArrived } from "./fulfillment"

/**
 * Whoever paid first is served first, out of whichever box is open.
 *
 * The items in a box are loose and identical, so a strap is a strap. Until now
 * a box effectively owned the customers it had been packed for: `unit_dispatch`
 * and `dispatch_receipt` live on the same order row, so the packer decided the
 * queue and paid-first never got a say. A customer who had paid could sit
 * waiting while three who had not were served from the box in front of you.
 *
 * So the queue now reaches across boxes, and the box being opened is used for
 * something else: to keep every box's outstanding count true. Its debt goes
 * down by what came out of it, and whoever is still waiting is moved onto the
 * boxes that still owe them -- which is what lets a box you have finished with
 * stop showing lines as pending.
 */

const TAG = `paidfirst${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
let productId = 0

/** Paid status comes from the invoice, so a payment is how a customer is ranked. */
async function makeOrder(customer: string, receipt: string, units: number, paid: boolean) {
  await sql`INSERT INTO customers (instagram_id) VALUES (${customer})`
  const [o] = (await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit,
                        unit_buy, unit_dispatch, dispatch_receipt, dispatched_at)
    VALUES (${EVENT}, ${customer}, ${productId}, 10000, ${units},
            ${units}, ${units}, ${receipt}, NOW())
    RETURNING id
  `) as unknown as { id: number }[]
  if (paid) {
    await sql`
      INSERT INTO payments (event, customer, amount, account, is_checked, kind)
      VALUES (${EVENT}, ${customer}, ${units * 10000 + 1_000_000}, 'test', true, 'deposit')
    `
  }
  return o.id
}

async function state() {
  const rows = (await sql`
    SELECT lower(replace(customer, '@', '')) AS customer,
           COALESCE(unit_arrive, 0)::int AS arrived,
           unit_dispatch::int AS dispatched,
           COALESCE(dispatch_receipt, '') AS receipt
      FROM orders WHERE event = ${EVENT} ORDER BY id
  `) as unknown as { customer: string; arrived: number; dispatched: number; receipt: string }[]
  return Object.fromEntries(rows.map((r) => [r.customer, r]))
}

test("a paid customer packed in a later box is served from the box that arrived", async () => {
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  const [p] = (await sql`
    INSERT INTO products (name, store, price, gram)
    VALUES (${`${TAG} Strap`}, 'MUJI', 10000, 50) RETURNING id
  `) as unknown as { id: number }[]
  productId = p.id

  // Three unpaid in the box that arrives; one paid in the box still at sea.
  await makeOrder(`${TAG}_dince`, "CJI-10", 1, false)
  await makeOrder(`${TAG}_elvi`, "CJI-10", 1, false)
  await makeOrder(`${TAG}_sei`, "CJI-10", 1, false)
  await makeOrder(`${TAG}_myna`, "KARINA2", 1, true)

  await markProductArrived({
    event: EVENT, productId, quantityArrived: 3, receipt: "CJI-10",
  })

  const s = await state()
  assert.equal(s[`${TAG}_myna`].arrived, 1, "she paid, so she is served first")
  assert.equal(s[`${TAG}_myna`].receipt, "CJI-10", "out of the box that was opened")

  const served = [`${TAG}_dince`, `${TAG}_elvi`, `${TAG}_sei`].filter((c) => s[c].arrived === 1)
  assert.equal(served.length, 2, "the other two units go to the earliest unpaid orders")

  // The one left over now waits for the box that still owes a unit, so CJI-10
  // stops showing a line it can no longer fill.
  const [waiting] = [`${TAG}_dince`, `${TAG}_elvi`, `${TAG}_sei`].filter((c) => s[c].arrived === 0)
  assert.equal(s[waiting].receipt, "KARINA2", "moved onto the box that still owes")
})

test("the box that was opened owes nothing afterwards", async () => {
  const rows = (await sql`
    SELECT COALESCE(dispatch_receipt, '') AS receipt,
           SUM(unit_dispatch - COALESCE(unit_arrive, 0))::int AS owed
      FROM orders WHERE event = ${EVENT} GROUP BY 1
  `) as unknown as { receipt: string; owed: number }[]
  const owed = Object.fromEntries(rows.map((r) => [r.receipt, r.owed]))
  assert.equal(owed["CJI-10"] ?? 0, 0, "emptied — nothing is still expected from it")
  assert.equal(owed["KARINA2"], 1, "the unit still at sea is owed by the box carrying it")
})

test("an order too big for what arrived is still served, and keeps waiting for the rest", async () => {
  // Way 2: the split is allowed, and the row then describes what is still owed
  // and by which box, rather than where the unit already in hand came from.
  const EV2 = `${TAG}_EV2`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV2}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${`${TAG}_conny`})`
  await sql`INSERT INTO customers (instagram_id) VALUES (${`${TAG}_harczk`})`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, dispatch_receipt, dispatched_at)
    VALUES (${EV2}, ${`${TAG}_conny`}, ${productId}, 10000, 2, 2, 2, 'CJI-77', NOW())
  `
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, dispatch_receipt, dispatched_at)
    VALUES (${EV2}, ${`${TAG}_harczk`}, ${productId}, 10000, 1, 1, 1, 'HC/KS', NOW())
  `
  await sql`
    INSERT INTO payments (event, customer, amount, account, is_checked, kind)
    VALUES (${EV2}, ${`${TAG}_conny`}, 1000000, 'test', true, 'deposit')
  `

  // One unit turns up in her box. She ordered two.
  await markProductArrived({ event: EV2, productId, quantityArrived: 1, receipt: "CJI-77" })

  const rows = (await sql`
    SELECT lower(replace(customer, '@', '')) AS customer, COALESCE(unit_arrive, 0)::int AS arrived,
           COALESCE(dispatch_receipt, '') AS receipt
      FROM orders WHERE event = ${EV2} ORDER BY id
  `) as unknown as { customer: string; arrived: number; receipt: string }[]
  const conny = rows.find((r) => r.customer === `${TAG}_conny`)!
  const harczk = rows.find((r) => r.customer === `${TAG}_harczk`)!

  assert.equal(conny.arrived, 1, "she paid, so the unit is hers even though it half-fills her order")
  assert.equal(harczk.arrived, 0, "the unpaid order waits")
  assert.equal(conny.receipt, "CJI-77", "CJI-77 still owes her the second unit")
  await sql`DELETE FROM orders WHERE event = ${EV2}`
  await sql`DELETE FROM payments WHERE event = ${EV2}`
  await sql`DELETE FROM customer_shipping_prefs WHERE event = ${EV2}`
  await sql`DELETE FROM adjustments WHERE event = ${EV2}`
  await sql`DELETE FROM events WHERE name = ${EV2}`
})

test("a part-filled order that also moves box keeps both facts straight", async () => {
  // The awkward one: she is served OUT of the box just opened, but her order is
  // bigger than what arrived, so she still waits — and the box she was packed
  // in is not the one that was opened. Two writes, deliberately ordered: the
  // fill carries the box the units came out of, so the received report credits
  // it; the move onto the box that still owes her comes after, touching no
  // quantity, so the report ignores it.
  const EV4 = `${TAG}_EV4`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV4}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${`${TAG}_big`})`
  await sql`INSERT INTO customers (instagram_id) VALUES (${`${TAG}_small`})`
  // She ordered 2, packed in the box still at sea, and has paid.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, dispatch_receipt, dispatched_at)
    VALUES (${EV4}, ${`${TAG}_big`}, ${productId}, 10000, 2, 2, 2, 'KARINA9', NOW())
  `
  await sql`
    INSERT INTO payments (event, customer, amount, account, is_checked, kind)
    VALUES (${EV4}, ${`${TAG}_big`}, 1000000, 'test', true, 'deposit')
  `
  // He ordered 1, packed in the box that arrives, and has not paid.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, dispatch_receipt, dispatched_at)
    VALUES (${EV4}, ${`${TAG}_small`}, ${productId}, 10000, 1, 1, 1, 'CJI-88', NOW())
  `

  await markProductArrived({ event: EV4, productId, quantityArrived: 1, receipt: "CJI-88" })

  const rows = (await sql`
    SELECT lower(replace(customer, '@', '')) AS customer, COALESCE(unit_arrive, 0)::int AS arrived,
           unit_dispatch::int AS dispatched, COALESCE(dispatch_receipt, '') AS receipt
      FROM orders WHERE event = ${EV4} ORDER BY id
  `) as unknown as { customer: string; arrived: number; dispatched: number; receipt: string }[]
  const big = rows.find((r) => r.customer === `${TAG}_big`)!
  const small = rows.find((r) => r.customer === `${TAG}_small`)!

  assert.equal(big.arrived, 1, "she paid, so the one unit is hers")
  assert.equal(big.receipt, "KARINA9", "she still waits on the box that owes her the second")
  assert.equal(small.arrived, 0, "the unpaid order waits")
  assert.equal(small.receipt, "KARINA9", "his box gave its unit away, so he moves to the one that owes")

  // The received report reads the audit log. The unit must be credited to the
  // box it physically came out of, not to the one she ends up waiting on.
  const credited = (await sql`
    SELECT COALESCE(a.new_row->>'dispatch_receipt', '') AS receipt,
           SUM((a.new_row->>'unit_arrive')::int - COALESCE((a.old_row->>'unit_arrive')::int, 0))::int AS units
      FROM audit.audit_log a
     WHERE a.table_name = 'orders' AND (a.new_row->>'event') = ${EV4}
       AND COALESCE((a.new_row->>'unit_arrive')::int, 0) > COALESCE((a.old_row->>'unit_arrive')::int, 0)
     GROUP BY 1
  `) as unknown as { receipt: string; units: number }[]
  assert.deepEqual(
    credited.map((r) => ({ receipt: r.receipt, units: r.units })),
    [{ receipt: "CJI-88", units: 1 }],
    "one unit received, credited to the box it came out of",
  )

  await sql`DELETE FROM orders WHERE event = ${EV4}`
  await sql`DELETE FROM payments WHERE event = ${EV4}`
  await sql`DELETE FROM customer_shipping_prefs WHERE event = ${EV4}`
  await sql`DELETE FROM adjustments WHERE event = ${EV4}`
  await sql`DELETE FROM events WHERE name = ${EV4}`
})

test("naming no box fills the same way and shuffles nothing", async () => {
  const EV3 = `${TAG}_EV3`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV3}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${`${TAG}_solo`})`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, dispatch_receipt, dispatched_at)
    VALUES (${EV3}, ${`${TAG}_solo`}, ${productId}, 10000, 2, 2, 2, 'MNC-1', NOW())
  `
  await markProductArrived({ event: EV3, productId, quantityArrived: 1 })
  const [r] = (await sql`
    SELECT COALESCE(unit_arrive,0)::int AS arrived, COALESCE(dispatch_receipt,'') AS receipt
      FROM orders WHERE event = ${EV3}
  `) as unknown as { arrived: number; receipt: string }[]
  assert.equal(r.arrived, 1)
  assert.equal(r.receipt, "MNC-1", "no box was opened, so no receipt moves")
  await sql`DELETE FROM orders WHERE event = ${EV3}`
  await sql`DELETE FROM customer_shipping_prefs WHERE event = ${EV3}`
  await sql`DELETE FROM adjustments WHERE event = ${EV3}`
  await sql`DELETE FROM events WHERE name = ${EV3}`
})

after(async () => {
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM payments WHERE event = ${EVENT}`
  await sql`DELETE FROM customer_shipping_prefs WHERE event = ${EVENT}`
  await sql`DELETE FROM adjustments WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM products WHERE id = ${productId}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})
