import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import {
  getShippingPrefs,
  setShippingMode,
  setMergeGroup,
  setTempAddress,
  ineligibleReason,
  ShippingPrefError,
} from "./shipping-prefs"
import { reapplyHoldsForArrival } from "./fulfillment"

const TAG = `shiptest${process.hrtime.bigint()}`
const PAID = `${TAG}_PAID`
const OWING = `${TAG}_OWING`
const OTHER = `${TAG}_OTHER`
const GONE = `${TAG}_GONE`

let customerId = 0
let handle = ""

after(async () => {
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM payments WHERE customer = ${handle}`
  await sql`DELETE FROM orders WHERE customer = ${handle}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

/** One line at 100.000, no ongkir configured, so the invoice is exactly that. */
async function seed() {
  handle = `${TAG}_cust`
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${handle}) RETURNING id`
  customerId = c.id

  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`

  for (const event of [PAID, OWING, OTHER, GONE]) {
    await sql`
      INSERT INTO events (name, warehouse_id)
      SELECT ${event}, id FROM warehouses ORDER BY id LIMIT 1`
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
      VALUES (${event}, ${handle}, ${p.id}, 100000, 2, 2)`
  }

  // Paid in full, except OWING. GONE has also already shipped.
  for (const event of [PAID, OTHER, GONE]) {
    await sql`
      INSERT INTO payments (event, customer, amount, is_checked, kind)
      VALUES (${event}, ${handle}, 200000, true, 'deposit')`
  }
  await sql`UPDATE orders SET unit_ship = 2 WHERE event = ${GONE} AND customer = ${handle}`
}

test("an unpaid event is refused, a paid one is not", async () => {
  await seed()
  assert.equal(await ineligibleReason(customerId, PAID), null)
  assert.equal(await ineligibleReason(customerId, OWING), "unpaid")
})

test("an event that has fully shipped is refused", async () => {
  assert.equal(await ineligibleReason(customerId, GONE), "shipped")
})

// The gate is the rule, not the UI that hides the control.
test("setting a mode on an unpaid event throws rather than writing", async () => {
  await assert.rejects(() => setShippingMode(customerId, OWING, "hold"), ShippingPrefError)
  assert.equal((await getShippingPrefs(customerId)).find((p) => p.event === OWING), undefined)
})

test("holding sets unit_hold, and leaving hold releases it", async () => {
  await setShippingMode(customerId, PAID, "hold")
  const held = await sql<{ h: string }[]>`
    SELECT COALESCE(SUM(unit_hold), 0) AS h FROM orders WHERE event = ${PAID} AND customer = ${handle}`
  assert.equal(Number(held[0].h), 2, "holding must reach the orders, not just the pref row")

  // Switching away by any door releases — otherwise the order stays invisibly
  // held and the shop never sees it again.
  await setShippingMode(customerId, PAID, "wait")
  const after = await sql<{ h: string }[]>`
    SELECT COALESCE(SUM(unit_hold), 0) AS h FROM orders WHERE event = ${PAID} AND customer = ${handle}`
  assert.equal(Number(after[0].h), 0)
})

test("a part-shipped event cannot be held", async () => {
  await sql`UPDATE orders SET unit_ship = 1 WHERE event = ${OTHER} AND customer = ${handle}`
  await assert.rejects(
    () => setShippingMode(customerId, OTHER, "hold"),
    (err: Error) => err.message === "part-shipped",
  )
  await sql`UPDATE orders SET unit_ship = 0 WHERE event = ${OTHER} AND customer = ${handle}`
})

test("split records the wish and ships nothing", async () => {
  await setShippingMode(customerId, PAID, "split")
  const [row] = await sql<{ s: string }[]>`
    SELECT COALESCE(SUM(unit_ship), 0) AS s FROM orders WHERE event = ${PAID} AND customer = ${handle}`
  assert.equal(Number(row.s), 0, "asking is not shipping")
  assert.equal((await getShippingPrefs(customerId)).find((p) => p.event === PAID)?.mode, "split")
})

test("pairing gives both events one key", async () => {
  const key = await setMergeGroup(customerId, [PAID, OTHER])
  assert.ok(key)
  const prefs = await getShippingPrefs(customerId)
  assert.equal(prefs.find((p) => p.event === PAID)?.mergeKey, key)
  assert.equal(prefs.find((p) => p.event === OTHER)?.mergeKey, key)
})

// A group of one is not a group.
test("naming a single event clears the group for everyone in it", async () => {
  await setMergeGroup(customerId, [PAID, OTHER])
  await setMergeGroup(customerId, [PAID])
  const prefs = await getShippingPrefs(customerId)
  assert.equal(prefs.find((p) => p.event === PAID)?.mergeKey, null)
  assert.equal(
    prefs.find((p) => p.event === OTHER)?.mergeKey,
    null,
    "the partner must not be left paired with nobody",
  )
})

test("an unpaid event cannot be smuggled into a group with a paid one", async () => {
  await assert.rejects(() => setMergeGroup(customerId, [PAID, OWING]), ShippingPrefError)
  assert.equal((await getShippingPrefs(customerId)).find((p) => p.event === OWING), undefined)
})

test("a temporary address is stored, and emptying it clears it", async () => {
  await setTempAddress(customerId, PAID, "  Jl. Kantor 12  ")
  assert.equal(
    (await getShippingPrefs(customerId)).find((p) => p.event === PAID)?.tempAddress,
    "Jl. Kantor 12",
  )
  await setTempAddress(customerId, PAID, "   ")
  assert.equal((await getShippingPrefs(customerId)).find((p) => p.event === PAID)?.tempAddress, null)
})

test("another customer's event is not routable", async () => {
  const [other] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${`${TAG}_stranger`}) RETURNING id`
  assert.equal(await ineligibleReason(other.id, PAID), "unknown")
  await assert.rejects(() => setShippingMode(other.id, PAID, "hold"), ShippingPrefError)
})


// ── the hold is a standing instruction, not a snapshot ──────
// holdPackingList parks what has arrived when it runs. Stock landing later is
// unheld unless something re-applies it, which is what every arrival path now
// calls. Without this a card reads Tunda Kirim while offering to ship.
//
// Its own event, with room to receive into: three ordered, two here, paid in
// full from the start so the arithmetic never moves.
test("stock arriving after a hold is parked with the rest", async () => {
  const LATE = `${TAG}_LATE`
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${LATE}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
    VALUES (${LATE}, ${handle}, ${p.id}, 100000, 3, 2)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${LATE}, ${handle}, 300000, true, 'deposit')`

  await setShippingMode(customerId, LATE, "hold")
  const held = async () => {
    const [r] = await sql<{ h: string; t: string }[]>`
      SELECT COALESCE(SUM(unit_hold), 0) AS h,
             COALESCE(SUM(GREATEST(unit_arrive - COALESCE(unit_ship,0) - COALESCE(unit_hold,0), 0)), 0) AS t
        FROM orders WHERE event = ${LATE} AND customer = ${handle}`
    return { hold: Number(r.h), toShip: Number(r.t) }
  }
  assert.deepEqual(await held(), { hold: 2, toShip: 0 }, "the two already here")

  // The third lands.
  await sql`UPDATE orders SET unit_arrive = 3 WHERE event = ${LATE} AND customer = ${handle}`
  assert.deepEqual(await held(), { hold: 2, toShip: 1 }, "unheld until the instruction is applied again")

  await reapplyHoldsForArrival(LATE, [handle])
  assert.deepEqual(await held(), { hold: 3, toShip: 0 }, "nothing packable under a hold")
})

test("an arrival for someone who never asked to hold is left alone", async () => {
  const [before] = await sql<{ h: string }[]>`
    SELECT COALESCE(SUM(unit_hold), 0) AS h FROM orders WHERE event = ${PAID} AND customer = ${handle}`
  await reapplyHoldsForArrival(PAID, [handle])
  const [after] = await sql<{ h: string }[]>`
    SELECT COALESCE(SUM(unit_hold), 0) AS h FROM orders WHERE event = ${PAID} AND customer = ${handle}`
  assert.equal(Number(after.h), Number(before.h))
})
