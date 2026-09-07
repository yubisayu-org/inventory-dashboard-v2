import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getShipOrdersFiltered } from "./fulfillment"
import { setShippingMode, setMergeGroup } from "./shipping-prefs"

// Saving a pair parks every member, which is how a pair is kept from being
// swept up by a bulk ship. It also meant a pair whose stock had all landed sat
// in Semua wearing "Tunda Kirim" — the same mark as a parcel somebody had
// actually asked to stop — with nothing to say the difference.
const TAG = `parked${process.hrtime.bigint()}`
const A = `${TAG}_A_CHINA`
const B = `${TAG}_B_JAPAN`
const WHO = `${TAG}_cust`
let customerId = 0

async function card(event: string) {
  const { groups } = await getShipOrdersFiltered({ segment: "all", search: WHO })
  return groups.find((g) => g.event === event) ?? null
}

before(async () => {
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${WHO}) RETURNING id`
  customerId = c.id
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  for (const e of [A, B]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
  }
  // Everything of A has landed; B is one short, the way hers was.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
    VALUES (${A}, ${WHO}, ${p.id}, 100000, 12, 12)`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
    VALUES (${B}, ${WHO}, ${p.id}, 100000, 5, 4)`

  // Pairing is refused while an order is unpaid — a customer may not direct
  // the shop's packing on credit — so both are settled first.
  for (const [e, amount] of [[A, 1200000], [B, 500000]] as const) {
    await sql`
      INSERT INTO payments (event, customer, amount, is_checked, kind)
      VALUES (${e}, ${WHO}, ${amount}, true, 'deposit')`
  }
})

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM payments WHERE customer = ${WHO}`
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM orders WHERE customer = ${WHO}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE id = ${customerId}`
  await sql.end()
})

test("a paired card is parked, not held", async () => {
  await setMergeGroup(customerId, [A, B])

  const a = await card(A)
  assert.ok(a)
  assert.equal(a.status, "paired", "the pair is the unit of work")
  assert.ok(a.orders.every((o) => o.unitHold > 0), "and its units are parked")
  assert.equal(a.holdRequested, false, "but nobody asked to hold it")
})

test("a hold she asked for survives being paired", async () => {
  await setShippingMode(customerId, B, "hold")

  const b = await card(B)
  assert.ok(b)
  assert.equal(b.status, "paired")
  assert.equal(b.holdRequested, true, "her own wish is still hers, and still said")

  const a = await card(A)
  assert.equal(a?.holdRequested, false, "and it belongs to the event she asked it on")
})
