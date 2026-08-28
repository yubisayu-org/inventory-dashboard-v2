import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { setShippingMode, clearHoldMode, setMergeGroup, getShippingPrefs } from "./shipping-prefs"
import { releasePackingList, reapplyHoldsForArrival } from "./fulfillment"

const TAG = `staffhold${process.hrtime.bigint()}`
const EV = `${TAG}_EV`
const EV2 = `${TAG}_EV2`
const WHO = `${TAG}_c`
let custId = 0
let productId = 0

async function orderFor(event: string, arrive: number) {
  const [o] = await sql<{ id: number }[]>`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive, unit_ship, unit_hold)
    VALUES (${event}, ${WHO}, ${productId}, 100000, 4, 4, 4, ${arrive}, 0, 0) RETURNING id`
  return o.id
}

/** What the Packing List would offer to pack. */
async function toShip(id: number) {
  const [r] = await sql<{ unit_arrive: number; unit_hold: number; unit_ship: number }[]>`
    SELECT unit_arrive, unit_hold, unit_ship FROM orders WHERE id = ${id}`
  return Math.max(0, r.unit_arrive - r.unit_ship - r.unit_hold)
}

async function modeOf(event: string) {
  return (await getShippingPrefs(custId)).find((p) => p.event === event)?.mode ?? null
}

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  productId = p.id
  for (const e of [EV, EV2]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
  }
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${WHO}) RETURNING id`
  custId = c.id
  // She has paid. Otherwise "unpaid" refuses her own hold before any of what
  // these tests are about is reached -- correctly, and unhelpfully here.
  for (const e of [EV, EV2]) {
    await sql`
      INSERT INTO payments (event, customer, amount, is_checked, kind)
      VALUES (${e}, ${WHO}, 10000000, true, 'deposit')`
  }
})

after(async () => {
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${custId}`
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("a shop hold holds what arrives after it", async () => {
  // Four ordered, two on the bench. The shop parks it.
  const id = await orderFor(EV, 2)
  await setShippingMode(custId, EV, "hold", sql, "shop")
  assert.equal(await toShip(id), 0, "the hold parks what is on the bench")

  // A third lands. Nothing about the hold is touched by anybody.
  await sql`UPDATE orders SET unit_arrive = 3 WHERE id = ${id}`
  await reapplyHoldsForArrival(EV, [WHO])
  assert.equal(
    await toShip(id), 0,
    "a unit that arrives after the hold is not exempt from it",
  )
  assert.equal(await modeOf(EV), "hold", "and the wish is on file, which is what re-applies it")
})

test("releasing a hold survives the next arrival", async () => {
  const id = await orderFor(EV2, 2)
  // She asks for it herself.
  await setShippingMode(custId, EV2, "hold", sql, "customer")
  assert.equal(await toShip(id), 0)

  // The shop releases it: units freed, and the request forgotten with them.
  await releasePackingList({ customer: WHO, event: EV2 })
  await clearHoldMode(custId, EV2)
  assert.equal(await toShip(id), 2, "released")
  assert.equal(await modeOf(EV2), "wait", "and nothing is left on file asking for it back")

  // The next box lands. This is where it used to be re-parked.
  await sql`UPDATE orders SET unit_arrive = 3 WHERE id = ${id}`
  await reapplyHoldsForArrival(EV2, [WHO])
  assert.equal(await toShip(id), 3, "a release is not undone by an unrelated arrival")
})

test("clearing a hold leaves a pairing alone", async () => {
  // A merge parks the parcel too, and un-pairing would take the merge discount
  // off her invoice. Ending a hold must not end that.
  await setMergeGroup(custId, [EV, EV2], sql, "shop")
  const before = (await getShippingPrefs(custId)).find((p) => p.event === EV)
  assert.ok(before?.mergeKey, "paired")

  await clearHoldMode(custId, EV)

  const after = (await getShippingPrefs(custId)).find((p) => p.event === EV)
  assert.equal(after?.mergeKey, before?.mergeKey, "still paired")
})

test("the shop can still park what is left of a part-shipped card", async () => {
  // The customer cannot: the queue and the parcel that already left would
  // disagree. The shop does it as a matter of course, and could before this
  // went through setShippingMode at all.
  const id = await orderFor(EV, 4)
  await sql`UPDATE orders SET unit_ship = 1 WHERE id = ${id}`
  await setShippingMode(custId, EV, "hold", sql, "shop")
  assert.equal(await toShip(id), 0)

  await assert.rejects(
    () => setShippingMode(custId, EV, "hold", sql, "customer"),
    /part-shipped/,
  )
})
