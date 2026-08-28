import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { setShippingMode, releaseHold } from "./shipping-prefs"
import { reapplyHoldsForArrival, releasePackingList } from "./fulfillment"

// Her story, end to end: she is overseas, five items on one order, boxes land
// one at a time, and she wants none of it sent until she is home.
const TAG = `holdstory${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const WHO = `${TAG}_c`
let customerId = 0
let orderId = 0

/** Another box lands: `n` more units of the order are now in hand. */
async function arrives(n: number) {
  await sql`UPDATE orders SET unit_arrive = COALESCE(unit_arrive, 0) + ${n} WHERE id = ${orderId}`
  // Every path that raises unit_arrive calls this; the standing instruction
  // wins again, or does not, depending on what the prefs row now says.
  await reapplyHoldsForArrival(EVENT, [WHO])
}

async function state() {
  const [o] = await sql<{ arrive: number; hold: number }[]>`
    SELECT COALESCE(unit_arrive,0)::int AS arrive, COALESCE(unit_hold,0)::int AS hold
      FROM orders WHERE id = ${orderId}`
  const [p] = await sql<{ mode: string }[]>`
    SELECT mode FROM customer_shipping_prefs WHERE customer_id = ${customerId} AND event = ${EVENT}`
  return { ...o, mode: p?.mode ?? "none" }
}

before(async () => {
  const [prod] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${WHO}) RETURNING id`
  customerId = c.id
  // Five items, and she has paid — an unpaid order is not hers to route.
  const [o] = await sql<{ id: number }[]>`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive, unit_ship)
    VALUES (${EVENT}, ${WHO}, ${prod.id}, 100000, 5, 5, 5, 0, 0) RETURNING id`
  orderId = o.id
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EVENT}, ${WHO}, 5000000, true, 'deposit')`
})

after(async () => {
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM payments WHERE event = ${EVENT}`
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id = ${WHO}`
  await sql.end()
})

test("a hold survives every box that lands after it", async () => {
  // 2 of 5 arrive, and she says hold. Whether she pressed it or the shop did
  // makes no difference to what happens next.
  await sql`UPDATE orders SET unit_arrive = 2 WHERE id = ${orderId}`
  await setShippingMode(customerId, EVENT, "hold", sql, "shop")
  assert.deepEqual(await state(), { arrive: 2, hold: 2, mode: "hold" })

  // A third lands. The hold was a snapshot of two units; without re-applying,
  // the card would say Tunda Kirim while offering to ship the new one.
  await arrives(1)
  assert.deepEqual(await state(), { arrive: 3, hold: 3, mode: "hold" }, "third item held too")

  // And a fourth.
  await arrives(1)
  assert.deepEqual(await state(), { arrive: 4, hold: 4, mode: "hold" }, "fourth item held too")
})

test("she comes home, it is released, and the four are shippable", async () => {
  // The staff door: one call that frees the units and forgets the wish.
  await releaseHold(customerId, WHO, EVENT)
  assert.deepEqual(await state(), { arrive: 4, hold: 0, mode: "wait" })
})

test("the fifth box does not put it back on hold", async () => {
  // This is the whole point of clearing the mode. The wish is gone, so the
  // arrival has nothing to re-apply.
  await arrives(1)
  assert.deepEqual(await state(), { arrive: 5, hold: 0, mode: "wait" },
    "released stays released")
})

test("freeing the units alone is what releaseHold exists to prevent", async () => {
  // What a release used to be, and what it would silently become again if
  // anyone reached for releasePackingList on its own. It looks finished -- the
  // units are free and the order is back on the packing list -- and then the
  // next box to land re-parks everything, hours later, through an action
  // nobody would connect to the release.
  await setShippingMode(customerId, EVENT, "hold", sql, "shop")
  assert.equal((await state()).hold, 5, "held again for the sake of the test")

  await releasePackingList({ customer: WHO, event: EVENT })   // half the job
  assert.deepEqual(await state(), { arrive: 5, hold: 0, mode: "hold" },
    "free, but the row still says she wants it held")

  await arrives(0)  // any arrival at all re-runs the standing instruction
  assert.equal((await state()).hold, 5, "and it is parked again, unasked")
})
