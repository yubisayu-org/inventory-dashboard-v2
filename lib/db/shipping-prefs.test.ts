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
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  // Each test that plants one removes it, but a failure between the two would
  // otherwise leave a charge on a row this file created.
  await sql`DELETE FROM adjustments WHERE customer = ${handle}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ${customerId}`
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

// The rule used to eat itself: asking to send early adds a fee, the fee made
// her unpaid, and unpaid forbade the change — including changing her mind. It
// now asks only whether the ITEMS are paid for, because every other charge on
// a trip is a consequence of the plan she is trying to change.
test("a debt that is only shipping does not lock her out", async () => {
  // PAID has its items settled. Every one of these is a shipping charge.
  for (const [description, auto] of [
    ["Ongkir kirim duluan", true],
    ["Selisih ongkir JNE", true],
    ["Ongkir tambahan manual", false],
  ] as const) {
    await sql`
      INSERT INTO adjustments (event, customer, description, amount, auto)
      VALUES (${PAID}, ${handle}, ${description}, 15000, ${auto})`
    try {
      assert.equal(await ineligibleReason(customerId, PAID), null, description)
    } finally {
      await sql`DELETE FROM adjustments WHERE event = ${PAID} AND customer = ${handle}`
    }
  }
})

test("a debt for the items themselves still locks her out", async () => {
  assert.equal(await ineligibleReason(customerId, OWING), "unpaid")
  // And a shipping charge on top of unpaid items changes nothing.
  await sql`
    INSERT INTO adjustments (event, customer, description, amount, auto)
    VALUES (${OWING}, ${handle}, 'Ongkir kirim duluan', 15000, true)`
  try {
    assert.equal(await ineligibleReason(customerId, OWING), "unpaid")
  } finally {
    await sql`DELETE FROM adjustments WHERE event = ${OWING} AND customer = ${handle}`
  }
})

// Paying for the items is the bar, not settling the invoice. An unpaid
// delivery fee is not a reason she cannot say how her parcels should travel —
// and the Ship button keeps its own gate, so nothing leaves unpaid either way.
test("unpaid delivery on a trip whose items are paid does not lock her out", async () => {
  // This file's seed configures no ongkir, so give it one large enough that
  // the old rule — invoice against payments — would certainly have refused.
  const [w] = await sql<{ id: number }[]>`SELECT id FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim, updated_at)
    VALUES (${customerId}, ${w.id}, 500000, NOW())
    ON CONFLICT (customer_id, warehouse_id)
    DO UPDATE SET ongkos_kirim = EXCLUDED.ongkos_kirim`
  try {
    assert.equal(await ineligibleReason(customerId, PAID), null)
  } finally {
    await sql`
      DELETE FROM customer_warehouse_ongkir
       WHERE customer_id = ${customerId} AND warehouse_id = ${w.id}`
  }
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

// ── every plan change is announced ───────────────────
// A customer held an order, released it and held it again, and heard back
// about none of the three. The ongkir notices announce money, and holding
// costs nothing — so the change she made most often was the one nothing said.
async function planNotices(): Promise<{ title: string; body: string }[]> {
  return (await sql`
    SELECT title, body FROM announcements
     WHERE customer_id = ${customerId} ORDER BY id`) as unknown as
    { title: string; body: string }[]
}

test("holding, releasing and holding again are each announced", async () => {
  const before = (await planNotices()).length
  await setShippingMode(customerId, PAID, "hold")
  await setShippingMode(customerId, PAID, "wait")
  await setShippingMode(customerId, PAID, "hold")

  const after = await planNotices()
  assert.equal(after.length, before + 3, "three changes, three notices")
  assert.match(after[after.length - 3].title, /ditahan/)
  assert.match(after[after.length - 2].title, /Menunggu lengkap/)
  assert.match(after[after.length - 1].title, /ditahan/)

  // Cleaned up so the tests after this one start from a known mode.
  await setShippingMode(customerId, PAID, "wait")
})

test("choosing the mode it already has says nothing", async () => {
  await setShippingMode(customerId, PAID, "split")
  const before = (await planNotices()).length
  await setShippingMode(customerId, PAID, "split")
  await setShippingMode(customerId, PAID, "split")
  assert.equal((await planNotices()).length, before, "this runs on every save")
  await setShippingMode(customerId, PAID, "wait")
})

// Who decided it is the part that is news. What she did herself she already
// knows; what the shop did to her order she does not.
test("a change the shop made says so, and one she made does not", async () => {
  await setShippingMode(customerId, PAID, "hold", sql, "shop")
  const shopSaid = (await planNotices()).pop()!
  assert.match(shopSaid.body, /oleh Yubisayu/)

  await setShippingMode(customerId, PAID, "wait", sql, "customer")
  const sheSaid = (await planNotices()).pop()!
  assert.doesNotMatch(sheSaid.body, /oleh Yubisayu/)
  assert.doesNotMatch(`${sheSaid.title} ${sheSaid.body}`, /\{\w+\}/, "no placeholder reaches her")
})

// A pairing is one decision about two parcels. Telling her twice about one box
// is how an inbox stops being read.
test("pairing and separating are announced once, naming the other order", async () => {
  const before = (await planNotices()).length
  await setMergeGroup(customerId, [PAID, OTHER])
  const merged = await planNotices()
  assert.equal(merged.length, before + 1, "one notice for one decision")
  assert.match(merged[merged.length - 1].title, /Digabung/)
  assert.match(merged[merged.length - 1].body, new RegExp(OTHER))

  await setMergeGroup(customerId, [PAID])
  const apart = await planNotices()
  assert.equal(apart.length, before + 2)
  assert.match(apart[apart.length - 1].title, /Tidak lagi digabung/)
  assert.match(apart[apart.length - 1].body, new RegExp(OTHER), "it names what it left")
})

test("re-confirming a pairing it already had says nothing", async () => {
  await setMergeGroup(customerId, [PAID, OTHER])
  const before = (await planNotices()).length
  await setMergeGroup(customerId, [PAID, OTHER])
  assert.equal((await planNotices()).length, before)
  await setMergeGroup(customerId, [PAID])
})
