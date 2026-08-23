import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import {
  getShipOrdersFiltered,
  shipCustomerOrders,
  shipMergedCustomerOrders,
  reapplyHoldsForArrival,
  PairedShipmentError,
} from "./fulfillment"
import { setMergeGroup, setShippingMode, getShippingPrefs } from "./shipping-prefs"
import { normalizeId, parcelPlanExtra } from "./helpers"

// Pairing parks both parcels, and combining is the door they leave by.

const TAG = `pairtest${process.hrtime.bigint()}`
const A = `${TAG}_A`
const B = `${TAG}_B`
const RATE = 25000

let customerId = 0
let handle = ""

after(async () => {
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM adjustments WHERE customer = ${handle}`
  await sql`DELETE FROM shipments WHERE customer = ${handle}`
  await sql`DELETE FROM payments WHERE customer = ${handle}`
  await sql`DELETE FROM orders WHERE customer = ${handle}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ${customerId}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

/** Two events, both paid. A has landed in full; B is one unit short. */
async function seed() {
  handle = `${TAG}_cust`
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${handle}) RETURNING id`
  customerId = c.id
  const [p] = await sql<{ id: number; gram: number }[]>`
    SELECT id, gram FROM products WHERE gram > 0 ORDER BY id LIMIT 1`

  for (const [name, arrive] of [[A, 2], [B, 1]] as const) {
    const [w] = await sql<{ id: number }[]>`
      INSERT INTO events (name, warehouse_id)
      SELECT ${name}, id FROM warehouses ORDER BY id LIMIT 1
      RETURNING warehouse_id AS id`
    await sql`
      INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
      VALUES (${customerId}, ${w.id}, ${RATE})
      ON CONFLICT (customer_id, warehouse_id) DO UPDATE SET ongkos_kirim = ${RATE}`
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
      VALUES (${name}, ${handle}, ${p.id}, 100000, 2, ${arrive})`
    const invoiced = 200000 + RATE * Math.ceil((p.gram * 2) / 1000)
    await sql`
      INSERT INTO payments (event, customer, amount, is_checked, kind)
      VALUES (${name}, ${handle}, ${invoiced}, true, 'deposit')`
  }
}

const card = async (event: string) => {
  const { groups } = await getShipOrdersFiltered({ event })
  return groups.find((g) => normalizeId(g.customer) === normalizeId(handle))
}
const heldUnits = async (event: string) => {
  const [r] = await sql<{ h: string }[]>`
    SELECT COALESCE(SUM(unit_hold), 0) AS h FROM orders WHERE event = ${event} AND customer = ${handle}`
  return Number(r.h)
}

test("pairing parks both parcels, so neither sits in Siap Kirim", async () => {
  await seed()
  assert.equal((await card(A))?.status, "ready", "before pairing, an ordinary ready card")

  await setMergeGroup(customerId, [A, B])
  assert.equal(await heldUnits(A), 2, "what had arrived is parked")
  const a = await card(A)
  assert.equal(a?.status, "paired", "and it leaves every other tab")
  assert.deepEqual(a?.pairedWith, [B])
})

// A pair waiting on stock is not work — the badge has to be able to reach zero.
test("the Gabung count is pairs that can go, not pairs that exist", async () => {
  const { counts } = await getShipOrdersFiltered({})
  assert.equal(counts.paired, 0, "B is still one unit short")

  await sql`UPDATE orders SET unit_arrive = 2 WHERE event = ${B} AND customer = ${handle}`
  await reapplyHoldsForArrival(B, [handle])
  const after = await getShipOrdersFiltered({})
  assert.equal(after.counts.paired, 1)
})

// The same reason a hold has to be re-applied: the wish outlives the moment.
test("stock landing on a paired event is parked with the rest", async () => {
  assert.equal(await heldUnits(B), 2, "the late unit was parked on arrival too")
  assert.equal((await card(B))?.totalToShip, 0)
})

test("shipping one half alone is refused until it is said out loud", async () => {
  const a = (await card(A))!
  await assert.rejects(
    () => shipCustomerOrders({
      customer: handle, event: A, orders: a.orders, weightKg: a.weightKg, ongkirPerKg: a.ongkirPerKg,
    }),
    (err: Error) => err instanceof PairedShipmentError && (err as PairedShipmentError).partners.includes(B),
  )
  const [{ n }] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM shipments WHERE customer = ${handle}`
  assert.equal(Number(n), 0, "nothing shipped while it was refused")
})

test("combining releases the parking itself, and spends the wish", async () => {
  const [a, b] = [(await card(A))!, (await card(B))!]
  // Both are parked, so toShip is zero until the release inside the merge.
  assert.equal(a.totalToShip, 0)

  const result = await shipMergedCustomerOrders({
    customer: handle,
    ongkirPerKg: a.ongkirPerKg,
    groups: [a, b].map((g) => ({
      event: g.event,
      orders: g.orders.map((o) => ({
        rowNumber: o.rowNumber, productId: o.productId, productName: o.productName,
        // What the screen would send after the release: everything that arrived.
        toShip: Math.max(0, o.unitArrive - o.unitShip), unitShip: o.unitShip, gram: o.gram,
      })),
    })),
  })

  assert.ok(result.shippingId)
  const rows = await sql<{ event: string; merge_group: string }[]>`
    SELECT event, merge_group FROM shipments WHERE customer = ${handle}`
  assert.equal(rows.length, 2, "one row per event")
  assert.equal(new Set(rows.map((r) => r.merge_group)).size, 1, "sharing one merge group")

  assert.equal(await heldUnits(A), 0, "the parking came off inside the merge")
  const prefs = await getShippingPrefs(customerId)
  assert.equal(prefs.find((p) => p.event === A)?.mergeKey, null, "the wish is spent, not left behind")
  assert.equal(prefs.find((p) => p.event === B)?.mergeKey, null)
})

// Separating is how she undoes it, and the parcels have to be free again.
test("separating releases the parcels it parked", async () => {
  const C = `${TAG}_C`
  const D = `${TAG}_D`
  const [p] = await sql<{ id: number; gram: number }[]>`
    SELECT id, gram FROM products WHERE gram > 0 ORDER BY id LIMIT 1`
  for (const name of [C, D]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${name}, id FROM warehouses ORDER BY id LIMIT 1`
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
      VALUES (${name}, ${handle}, ${p.id}, 100000, 1, 1)`
    await sql`
      INSERT INTO payments (event, customer, amount, is_checked, kind)
      VALUES (${name}, ${handle}, ${100000 + RATE * Math.ceil(p.gram / 1000)}, true, 'deposit')`
  }
  await setMergeGroup(customerId, [C, D])
  assert.equal(await heldUnits(C), 1)

  await setMergeGroup(customerId, [C])
  assert.equal(await heldUnits(C), 0, "no longer paired, no longer parked")
  assert.equal(await heldUnits(D), 0, "and neither is the partner it left behind")
})

// An outright hold is a different wish, and losing a partner must not lift it.
test("a hold survives the pairing that was on top of it", async () => {
  const E = `${TAG}_E`
  const [p] = await sql<{ id: number; gram: number }[]>`
    SELECT id, gram FROM products WHERE gram > 0 ORDER BY id LIMIT 1`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${E}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
    VALUES (${E}, ${handle}, ${p.id}, 100000, 1, 1)`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${E}, ${handle}, ${100000 + RATE * Math.ceil(p.gram / 1000)}, true, 'deposit')`

  await setShippingMode(customerId, E, "hold")
  const F = `${TAG}_C`
  await setMergeGroup(customerId, [E, F])
  await setMergeGroup(customerId, [F])

  assert.equal(await heldUnits(E), 1, "she asked for this one to be held, separately")
})


// ── an early box, with the remainder still paired ────────────
// She asked for these to travel together, not to travel together once. What
// is left after an early box stays a pair, so it comes back as one parcel
// instead of two loose ones she has to pair again.
test("a partial merged shipment leaves the pairing standing", async () => {
  const G = `${TAG}_G`
  const H = `${TAG}_H`
  const [p] = await sql<{ id: number; gram: number }[]>`
    SELECT id, gram FROM products WHERE gram > 0 ORDER BY id LIMIT 1`
  for (const name of [G, H]) {
    const [w] = await sql<{ id: number }[]>`
      INSERT INTO events (name, warehouse_id)
      SELECT ${name}, id FROM warehouses ORDER BY id LIMIT 1
      RETURNING warehouse_id AS id`
    await sql`
      INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
      VALUES (${customerId}, ${w.id}, ${RATE})
      ON CONFLICT (customer_id, warehouse_id) DO UPDATE SET ongkos_kirim = ${RATE}`
    // Four ordered, two here: an early box is possible and a remainder exists.
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
      VALUES (${name}, ${handle}, ${p.id}, 100000, 4, 2)`
    await sql`
      INSERT INTO payments (event, customer, amount, is_checked, kind)
      VALUES (${name}, ${handle}, ${400000 + RATE * Math.ceil((p.gram * 4) / 1000)}, true, 'deposit')`
  }
  await setShippingMode(customerId, G, "split")
  await setShippingMode(customerId, H, "split")
  await setMergeGroup(customerId, [G, H])

  const early = async (event: string) => {
    const { groups } = await getShipOrdersFiltered({ event })
    const g = groups.find((x) => normalizeId(x.customer) === normalizeId(handle))!
    return {
      event,
      orders: g.orders.map((o) => ({
        rowNumber: o.rowNumber, productId: o.productId, productName: o.productName,
        toShip: Math.max(0, o.unitArrive - o.unitShip), unitShip: o.unitShip, gram: o.gram,
      })),
    }
  }
  await shipMergedCustomerOrders({
    customer: handle, ongkirPerKg: RATE, groups: [await early(G), await early(H)],
  })

  const prefs = await getShippingPrefs(customerId)
  const keyG = prefs.find((x) => x.event === G)?.mergeKey
  assert.ok(keyG, "half shipped is not the end of the pairing")
  assert.equal(prefs.find((x) => x.event === H)?.mergeKey, keyG, "and the partner keeps the same key")

  // The remainder arrives, and the pair comes back as one piece of work.
  await sql`UPDATE orders SET unit_arrive = 4 WHERE event = ANY(${[G, H]}) AND customer = ${handle}`
  for (const e of [G, H]) await reapplyHoldsForArrival(e, [handle])
  const { counts } = await getShipOrdersFiltered({})
  assert.ok(counts.paired >= 1, "back in the Gabung tab, together")
})

// One plan, one charge: the early box and the remainder are priced together,
// so nothing is asked for again when the rest turns up.
test("the whole plan is priced once, not per parcel", () => {
  // Two events, 2 kg each ordered, half of each going early.
  const lines = (unit: number, toShip: number) => [{ gram: 1000, unit, toShip }]
  const plan = parcelPlanExtra([{ lines: lines(2, 1) }, { lines: lines(2, 1) }], 25000)
  // invoiced 2 + 2 kg; reality 2 kg early + 2 kg remainder — the same.
  assert.equal(plan, 0)

  // Now one event only: 2 kg ordered, 1 kg early — two parcels against one.
  assert.equal(parcelPlanExtra([{ lines: lines(2, 1) }], 25000), 0)
  // 1.5 kg ordered (2 kg billed), 0.5 kg early: 1 + 1 against 2 — still level.
  assert.equal(parcelPlanExtra([{ lines: [{ gram: 500, unit: 3, toShip: 1 }] }], 25000), 0)
  // 1.2 kg + 1.4 kg in one box now, nothing left: 3 kg against 2 + 2.
  assert.equal(
    parcelPlanExtra(
      [{ lines: [{ gram: 600, unit: 2, toShip: 2 }] }, { lines: [{ gram: 700, unit: 2, toShip: 2 }] }],
      25000,
    ),
    -25000,
    "combining is a saving, and the same sum says so",
  )
})
