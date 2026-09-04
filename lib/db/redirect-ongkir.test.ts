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
