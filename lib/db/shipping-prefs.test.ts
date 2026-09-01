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
import { reapplyHoldsForArrival, getShipOrdersFiltered } from "./fulfillment"
import { normalizeId } from "./helpers"

const TAG = `shiptest${process.hrtime.bigint()}`
const PAID = `${TAG}_PAID`
const OWING = `${TAG}_OWING`
const OTHER = `${TAG}_OTHER`
const GONE = `${TAG}_GONE`

let customerId = 0
let handle = ""

after(async () => {
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  // Each test that plants one removes it, but a failure between the two would
  // otherwise leave a charge on a row this file created.
  await sql`DELETE FROM adjustments WHERE customer = ${handle}`
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

// The rule used to eat itself: asking to send early adds a fee, the fee makes
// her unpaid, and being unpaid forbids the change — including changing her
// mind. blocks() has always named this; the shop was exempted so somebody
// could act, and the customer was left in the dead end.
test("a debt that is only her own parcel-plan fee does not lock her out", async () => {
  // PAID is settled. Now the plan she asked for adds its fee, exactly as
  // reconcileParcelPlan writes it: automatic, and not the JNE reconciliation.
  await sql`
    INSERT INTO adjustments (event, customer, description, amount, auto)
    VALUES (${PAID}, ${handle}, 'Ongkir kirim duluan', 15000, true)`
  try {
    assert.equal(
      await ineligibleReason(customerId, PAID),
      null,
      "she must still be able to change the plan that created the fee",
    )
  } finally {
    await sql`DELETE FROM adjustments WHERE event = ${PAID} AND customer = ${handle}`
  }
})

test("a debt for the goods themselves still locks her out, fee or no fee", async () => {
  // OWING has never been paid. A plan fee on top does not excuse the rest.
  await sql`
    INSERT INTO adjustments (event, customer, description, amount, auto)
    VALUES (${OWING}, ${handle}, 'Ongkir kirim duluan', 15000, true)`
  try {
    assert.equal(await ineligibleReason(customerId, OWING), "unpaid")
  } finally {
    await sql`DELETE FROM adjustments WHERE event = ${OWING} AND customer = ${handle}`
  }
})

// Only the plan's own row is set aside. A manual charge, or the JNE
// reconciliation, is an ordinary debt and keeps the gate shut.
test("another kind of adjustment is not excused", async () => {
  for (const [description, auto] of [["Selisih ongkir JNE", true], ["Denda", false]] as const) {
    await sql`
      INSERT INTO adjustments (event, customer, description, amount, auto)
      VALUES (${PAID}, ${handle}, ${description}, 15000, ${auto})`
    try {
      assert.equal(await ineligibleReason(customerId, PAID), "unpaid", description)
    } finally {
      await sql`DELETE FROM adjustments WHERE event = ${PAID} AND customer = ${handle}`
    }
  }
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
  await setTempAddress(customerId, PAID, { address: "  Jl. Kantor 12  " })
  assert.equal(
    (await getShippingPrefs(customerId)).find((p) => p.event === PAID)?.tempAddress,
    "Jl. Kantor 12",
  )
  await setTempAddress(customerId, PAID, { address: "   " })
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


// ── the address has to reach the screen that prints the label ──
test("an address she asked for arrives on the ship card", async () => {
  await setTempAddress(customerId, PAID, { address: "Jl. Melati 8, Bandung" })
  const { groups } = await getShipOrdersFiltered({ event: PAID })
  const mine = groups.find((g) => normalizeId(g.customer) === normalizeId(handle))
  assert.equal(mine?.requestedAddress, "Jl. Melati 8, Bandung")

  await setTempAddress(customerId, PAID, { address: "" })
  const after = await getShipOrdersFiltered({ event: PAID })
  const cleared = after.groups.find((g) => normalizeId(g.customer) === normalizeId(handle))
  assert.equal(cleared?.requestedAddress, null, "clearing it must fall back to her profile address")
})

test("an event she said nothing about carries no address", async () => {
  const { groups } = await getShipOrdersFiltered({ event: OWING })
  const mine = groups.find((g) => normalizeId(g.customer) === normalizeId(handle))
  assert.equal(mine?.requestedAddress, null)
})


// The area rides with the address, and clearing the address clears both — an
// area with no street is not somewhere a courier can go.
test("the chosen area is stored with the address and cleared with it", async () => {
  await setTempAddress(customerId, PAID, {
    address: "Jl. Melati 8",
    areaId: "IDNP6IDNC144IDND885IDZ40132",
    areaName: "Jawa Barat, Bandung, Coblong, 40132",
  })
  const saved = (await getShippingPrefs(customerId)).find((p) => p.event === PAID)
  assert.equal(saved?.tempAreaId, "IDNP6IDNC144IDND885IDZ40132")
  assert.equal(saved?.tempAreaName, "Jawa Barat, Bandung, Coblong, 40132")

  const { groups } = await getShipOrdersFiltered({ event: PAID })
  const card = groups.find((g) => normalizeId(g.customer) === normalizeId(handle))
  assert.equal(card?.requestedAddress, "Jl. Melati 8\nJawa Barat, Bandung, Coblong, 40132")
  assert.equal(card?.requestedOtherArea, true, "her profile has no area, so this one differs")

  await setTempAddress(customerId, PAID, { address: "", areaId: "x", areaName: "y" })
  const cleared = (await getShippingPrefs(customerId)).find((p) => p.event === PAID)
  assert.equal(cleared?.tempAddress, null)
  assert.equal(cleared?.tempAreaId, null, "an area with nowhere to deliver is not kept")
})
