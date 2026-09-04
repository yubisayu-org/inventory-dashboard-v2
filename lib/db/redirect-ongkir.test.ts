import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { setTempAddress } from "./shipping-prefs"
import { priceRedirect } from "./redirect-ongkir"

// A redirect to another area costs another price. The charge is an ordinary
// automatic adjustment — the same shape reweighing already uses — so every
// screen that reads adjustments reads this one without being taught to.

const TAG = `redir${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const HOME_AREA = `${TAG}_home`
const AWAY_AREA = `${TAG}_away`

let customerId = 0
let handle = ""

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM adjustments WHERE event = ${EVENT}`
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM orders WHERE customer = ${handle}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ${customerId}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

async function seed() {
  handle = `${TAG}_cust`
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id, biteship_area_id) VALUES (${handle}, ${HOME_AREA})
    RETURNING id`
  customerId = c.id

  const [w] = await sql<{ id: number }[]>`SELECT id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO events (name, warehouse_id) VALUES (${EVENT}, ${w.id})`
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
    VALUES (${customerId}, ${w.id}, 25000)`

  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
    VALUES (${EVENT}, ${handle}, ${p.id}, 200000, 2, 2)`
}

/** The one automatic row a redirect is allowed to own. */
async function charge() {
  const [row] = await sql<{ amount: number; description: string }[]>`
    SELECT amount, description FROM adjustments
     WHERE event = ${EVENT} AND auto AND description LIKE 'Ongkir alamat berbeda%'`
  return row ?? null
}

test("a redirect with no quote charges nothing, and says so by leaving the rate empty", async () => {
  await seed()
  // These area ids are ours, not Biteship's, so the courier cannot price them
  // — which is exactly the case a real unquotable area produces.
  await setTempAddress(customerId, EVENT, {
    address: "Jl. Melati 4", areaId: AWAY_AREA, areaName: "Somewhere, Else",
    name: "Ibu Laily", phone: "0813 2222 1111",
  })

  const [pref] = await sql<{ temp_ongkir_per_kg: number | null; temp_name: string; temp_phone: string }[]>`
    SELECT temp_ongkir_per_kg, temp_name, temp_phone FROM customer_shipping_prefs
     WHERE customer_id = ${customerId} AND event = ${EVENT}`
  assert.equal(pref.temp_ongkir_per_kg, null, "no rate was invented")
  assert.equal(pref.temp_name, "Ibu Laily", "the parcel is going to somebody else")
  assert.equal(pref.temp_phone, "0813 2222 1111")
  assert.equal(await charge(), null, "and nobody is charged for a figure we do not have")
})

test("a quote that differs is charged once, updated in place, and taken back when she reverts", async () => {
  // The courier is not reachable from a test, so the quote is written the way
  // priceRedirect would have written it and the arithmetic is checked from
  // there — the rate is the only part that comes from outside.
  await sql`
    UPDATE customer_shipping_prefs SET temp_ongkir_per_kg = 39000
     WHERE customer_id = ${customerId} AND event = ${EVENT}`

  const [row] = await sql<{ weight: string }[]>`
    SELECT CEIL(COALESCE(SUM(p.gram * o.unit), 0)::numeric / 1000) AS weight
      FROM orders o JOIN products p ON p.id = o.product_id
     WHERE o.event = ${EVENT} AND o.customer = ${handle}`
  const weightKg = Number(row.weight)

  await sql`
    INSERT INTO adjustments (event, customer, description, amount, auto)
    VALUES (${EVENT}, ${handle}, ${`Ongkir alamat berbeda (${weightKg} kg)`},
            ${(39000 - 25000) * weightKg}, true)`

  const first = await charge()
  assert.ok(first)
  assert.equal(first.amount, (39000 - 25000) * weightKg, "the gap times this parcel's weight")

  // Clearing the address is how a redirect is undone, and the charge goes with
  // it: nothing is being sent anywhere unusual any more.
  await setTempAddress(customerId, EVENT, { address: "" })
  assert.equal(await charge(), null, "the charge does not outlive the redirect")

  const [after] = await sql<{ temp_ongkir_per_kg: number | null; temp_name: string }[]>`
    SELECT temp_ongkir_per_kg, temp_name FROM customer_shipping_prefs
     WHERE customer_id = ${customerId} AND event = ${EVENT}`
  assert.equal(after.temp_ongkir_per_kg, null)
  assert.equal(after.temp_name, "", "and neither does the recipient")
})

test("pricing an event with nothing redirected simply removes any charge", async () => {
  const result = await priceRedirect(customerId, EVENT)
  assert.equal(result, null)
  assert.equal(await charge(), null)
})


// A split puts two parcels on one trip, and the redirect flow has to survive
// being used twice: once for the early box, once for what follows.
test("a spent charge is settled, so the next redirect starts a new one", async () => {
  const { settleRedirectCharge, finaliseRedirectCharge } = await import("./redirect-ongkir")

  await setTempAddress(customerId, EVENT, {
    address: "Jl. Pondok Aren 1", areaId: AWAY_AREA, areaName: "Pondok Aren, Tangerang Selatan",
    name: "Sari", phone: "0812",
  })
  // The courier is unreachable from a test, so the rate is written the way a
  // successful quote would have written it.
  await sql`
    UPDATE customer_shipping_prefs SET temp_ongkir_per_kg = 39000
     WHERE customer_id = ${customerId} AND event = ${EVENT}`

  // The box is packed and weighed: five kilos, not the whole order's guess.
  await finaliseRedirectCharge(handle, EVENT, 5)
  const [first] = await sql<{ id: number; amount: number; description: string }[]>`
    SELECT id, amount, description FROM adjustments WHERE event = ${EVENT} AND auto`
  assert.equal(first.amount, (39000 - 25000) * 5, "priced on the box that went")
  assert.match(first.description, /Pondok Aren/, "and named, since a split can leave two of these")

  // It goes with the parcel, so it stops being editable.
  await settleRedirectCharge(handle, EVENT)

  // A second redirect on the same trip must not rewrite the first parcel's
  // charge — that would refund a delivery that really happened.
  await sql`
    UPDATE customer_shipping_prefs
       SET temp_address = 'Jl. Kebayoran 2', temp_area_id = ${`${AWAY_AREA}2`},
           temp_area_name = 'Kebayoran Baru, Jakarta Selatan', temp_ongkir_per_kg = 24000
     WHERE customer_id = ${customerId} AND event = ${EVENT}`
  await finaliseRedirectCharge(handle, EVENT, 3)

  const rows = await sql<{ amount: number; description: string }[]>`
    SELECT amount, description FROM adjustments WHERE event = ${EVENT} AND auto ORDER BY id`
  assert.equal(rows.length, 2, "two boxes, two charges")
  assert.equal(rows[0].amount, (39000 - 25000) * 5, "the first is untouched")
  assert.match(rows[0].description, /terkirim/, "and marked as gone")
  assert.equal(rows[1].amount, (24000 - 25000) * 3, "the second is its own, and a credit")
  assert.match(rows[1].description, /Kebayoran Baru/)
})

// Pressing Ship does not put the box on a van. The parcels are packed one at a
// time, and a customer asking for somewhere else in that gap is ordinary — so
// the correction is priced, against what this parcel has already been charged.
test("correcting a shipped parcel's area charges the difference, once", async () => {
  const { repriceShippedRedirect } = await import("./redirect-ongkir")

  const [w] = await sql<{ id: number }[]>`SELECT id FROM warehouses ORDER BY id LIMIT 1`
  const [ship] = await sql<{ id: number }[]>`
    INSERT INTO shipments (event, customer, shipping_id, weight_estimation, ongkir, ongkir_total,
                           temp_address, temp_area_id, temp_area_name)
    VALUES (${EVENT}, ${handle}, ${`${TAG}-SH`}, 5, 25000, 125000,
            'Jl. Pondok Aren 1', ${AWAY_AREA}, 'Pondok Aren, Tangerang Selatan')
    RETURNING id`
  await sql`UPDATE events SET warehouse_id = ${w.id} WHERE name = ${EVENT}`

  // Nothing is written while it only answers.
  const before = await sql`SELECT count(*)::int AS n FROM adjustments WHERE event = ${EVENT}`
  const asked = await repriceShippedRedirect(ship.id, `${AWAY_AREA}3`, "Limo, Depok", false)
  const after = await sql`SELECT count(*)::int AS n FROM adjustments WHERE event = ${EVENT}`
  assert.equal(after[0].n, before[0].n, "asking changes nothing")

  // The courier cannot be reached from a test, so the quote comes back empty —
  // and an empty quote must charge nothing rather than charge zero.
  assert.equal(asked?.perKg, null)
  assert.equal(asked?.delta, 0)
  assert.equal(asked?.weightKg, 5, "priced on the kilos this parcel was billed for")

  await sql`DELETE FROM shipments WHERE id = ${ship.id}`
})
