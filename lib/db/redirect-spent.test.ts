import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { shipCustomerOrders } from "./fulfillment"
import { setTempAddress, getShippingPrefs } from "./shipping-prefs"

const TAG = `redirect${process.hrtime.bigint()}`
const EV = `${TAG}_EV`
const EV2 = `${TAG}_EV2`
const WHO = `${TAG}_c`
let custId = 0
let productId = 0

async function lineFor(event: string) {
  const [o] = await sql<{ id: number }[]>`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive, unit_ship)
    VALUES (${event}, ${WHO}, ${productId}, 100000, 4, 4, 4, 4, 0) RETURNING id`
  return o.id
}

async function ship(event: string, id: number, toShip: number, tempAddress: string | null) {
  await shipCustomerOrders({
    customer: WHO, event, weightKg: 1, ongkirPerKg: 20000, tempAddress,
    orders: [{ rowNumber: id, productId, productName: "x", toShip, unitShip: 0 }],
  })
}

const addressOn = async (event: string) =>
  (await getShippingPrefs(custId)).find((p) => p.event === event)?.tempAddress ?? null

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  productId = p.id
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${WHO}) RETURNING id`
  custId = c.id
  for (const e of [EV, EV2]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
    await sql`
      INSERT INTO payments (event, customer, amount, is_checked, kind)
      VALUES (${e}, ${WHO}, 10000000, true, 'deposit')`
  }
})

after(async () => {
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${custId}`
  await sql`DELETE FROM announcements WHERE customer_id = ${custId}`
  await sql`DELETE FROM shipments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("a redirect is spent by the parcel it was for", async () => {
  const id = await lineFor(EV)
  await setTempAddress(custId, EV, { address: "Rumah ibu, Jl. Melati 4" })
  assert.ok(await addressOn(EV), "she asked")

  // The first box goes to her mother's.
  await ship(EV, id, 2, "Rumah ibu, Jl. Melati 4")

  assert.equal(
    await addressOn(EV), null,
    "the ask was about that box; the second must not inherit it",
  )
})

test("a redirect the parcel did not use still stands", async () => {
  const id = await lineFor(EV2)
  await setTempAddress(custId, EV2, { address: "Rumah ibu, Jl. Melati 4" })

  // Sent to her profile address instead — her request was not honoured.
  await ship(EV2, id, 2, null)

  assert.equal(
    await addressOn(EV2), "Rumah ibu, Jl. Melati 4",
    "an unmet request is not spent",
  )
})

test("the shipment keeps where the box actually went", async () => {
  const rows = await sql<{ temp_address: string | null }[]>`
    SELECT temp_address FROM shipments WHERE event = ${EV}`
  assert.equal(rows[0].temp_address, "Rumah ibu, Jl. Melati 4",
    "clearing the request must not lose the record of the delivery")
})

test("the shop can record a redirect she asked for by message", async () => {
  // She says it on WhatsApp, weeks before anything arrives. Written down here
  // it waits on the trip like one she set herself -- badge, seeded sheet, and
  // spent by the box that uses it.
  const EV3 = `${TAG}_EV3`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV3}, id FROM warehouses ORDER BY id LIMIT 1`
  const id = await lineFor(EV3)

  // Deliberately unpaid: this is early, which is the whole point. A
  // destination is not a commitment, so since the redirect was opened to
  // customers who still owe, her own page may set one here too — what she
  // still may not do while owing is direct the packing.
  await setTempAddress(custId, EV3, { address: "Kos Melati 3A" }, sql, "customer")
  assert.equal(await addressOn(EV3), "Kos Melati 3A")

  await setTempAddress(custId, EV3, { address: "Kos Melati 3B" }, sql, "shop")
  assert.equal(await addressOn(EV3), "Kos Melati 3B")

  await ship(EV3, id, 2, "Kos Melati 3B")
  assert.equal(await addressOn(EV3), null, "spent by the parcel, however it was recorded")
})
