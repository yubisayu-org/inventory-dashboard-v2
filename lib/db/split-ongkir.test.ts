import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import {
  splitExtraOngkir,
  chargeSplitOngkir,
  getShipOrdersFiltered,
  SPLIT_ONGKIR_NOTE,
} from "./fulfillment"
import { setShippingMode } from "./shipping-prefs"
import { normalizeId } from "./helpers"

// Sending part of an order early costs a second delivery fee, and the shop
// bills it before the parcel goes rather than chasing it afterwards.

const TAG = `splittest${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const RATE = 25000

let customerId = 0
let handle = ""
let gram = 0

after(async () => {
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM adjustments WHERE customer = ${handle}`
  await sql`DELETE FROM payments WHERE customer = ${handle}`
  await sql`DELETE FROM orders WHERE customer = ${handle}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ${customerId}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

/** Two lines of two units. One line has landed, the other has not. */
async function seed() {
  handle = `${TAG}_cust`
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${handle}) RETURNING id`
  customerId = c.id

  const products = await sql<{ id: number; gram: number }[]>`
    SELECT id, gram FROM products WHERE gram > 0 ORDER BY id LIMIT 2`
  assert.ok(products.length === 2, "needs two weighed products to split")
  gram = products[0].gram

  const [w] = await sql<{ id: number }[]>`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    RETURNING warehouse_id AS id`
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
    VALUES (${customerId}, ${w.id}, ${RATE})
    ON CONFLICT (customer_id, warehouse_id) DO UPDATE SET ongkos_kirim = ${RATE}`

  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
    VALUES (${EVENT}, ${handle}, ${products[0].id}, 100000, 2, 2)`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
    VALUES (${EVENT}, ${handle}, ${products[1].id}, 100000, 2, 0)`

  // Settle it exactly, or she cannot ask for anything at all.
  const fullGram = products[0].gram * 2 + products[1].gram * 2
  const invoiced = 400000 + RATE * Math.ceil(fullGram / 1000)
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EVENT}, ${handle}, ${invoiced}, true, 'deposit')`
  return { products, fullGram }
}

// ── the arithmetic, on its own ───────────────────────────────
// Same shape as the merge discount: two parcels rounded separately against one
// rounded whole. Worth testing without a database, because the interesting
// cases are all about rounding.
test("the extra is what rounding two parcels costs over rounding one", () => {
  // 1.2 kg now + 1.4 kg later = 2 + 2 kg billed, against 3 kg for the whole.
  const lines = [
    { gram: 600, unit: 4, toShip: 2 },
    { gram: 700, unit: 2, toShip: 0 },
  ]
  assert.equal(splitExtraOngkir(lines, 25000), 25000)
})

test("rounding often absorbs it, and then there is nothing to bill", () => {
  // 300 g now, 400 g later: 1 kg + 1 kg against 1 kg — one extra kilo.
  assert.equal(splitExtraOngkir([{ gram: 100, unit: 7, toShip: 3 }], 25000), 25000)
  // A whole kilo each side, and one whole kilo either way: nothing extra.
  assert.equal(splitExtraOngkir([{ gram: 1000, unit: 2, toShip: 1 }], 25000), 0)
})

test("nothing to send, or nothing left behind, is not a split", () => {
  assert.equal(splitExtraOngkir([{ gram: 800, unit: 2, toShip: 0 }], 25000), 0)
  assert.equal(splitExtraOngkir([{ gram: 800, unit: 2, toShip: 2 }], 25000), 0)
})

// ── the queue ────────────────────────────────────────────────
test("asking for it puts the card in its own segment, not in Tiba Sebagian", async () => {
  await seed()
  const before = await getShipOrdersFiltered({ event: EVENT })
  assert.equal(before.groups[0].status, "partial", "before she asks, an ordinary partial card")

  await setShippingMode(customerId, EVENT, "split")
  const { groups, counts } = await getShipOrdersFiltered({ event: EVENT })
  const card = groups.find((g) => normalizeId(g.customer) === normalizeId(handle))
  assert.equal(card?.status, "split_requested")
  assert.equal(card?.splitRequested, true)
  assert.equal(counts.split_requested, 1)
  assert.equal(counts.partial, 0)

  const expected = RATE * (Math.ceil((gram * 2) / 1000) + Math.ceil((gram * 2) / 1000) - Math.ceil((gram * 4) / 1000))
  assert.equal(card?.splitExtraOngkir, expected)
  assert.equal(card?.splitCharged, false)
})

test("charging it writes one adjustment and tells her why", async () => {
  const { amount } = await chargeSplitOngkir({ customer: handle, event: EVENT })
  assert.ok(amount > 0)

  const [adj] = await sql<{ amount: string; description: string }[]>`
    SELECT amount, description FROM adjustments
     WHERE event = ${EVENT} AND customer = ${handle}`
  assert.equal(adj.description, SPLIT_ONGKIR_NOTE)
  assert.equal(Number(adj.amount), amount, "positive: this is a charge, not a discount")

  const [notice] = await sql<{ title: string; kind: string }[]>`
    SELECT title, kind FROM announcements WHERE customer_id = ${customerId}`
  assert.match(notice.title, new RegExp(EVENT))
  assert.equal(notice.kind, "shipping")
})

// The adjustment is the record that it happened — there is no flag to forget.
test("a second click finds the first one and refuses", async () => {
  await assert.rejects(() => chargeSplitOngkir({ customer: handle, event: EVENT }), /sudah ditagihkan/)
  const [{ n }] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM adjustments WHERE event = ${EVENT} AND customer = ${handle}`
  assert.equal(Number(n), 1)
})

// The whole point of billing first: the ordinary payment gate now holds the
// parcel, without a second mechanism to keep in step with it.
test("the charge leaves the order unpaid until she settles it", async () => {
  const { groups } = await getShipOrdersFiltered({ event: EVENT })
  const card = groups.find((g) => normalizeId(g.customer) === normalizeId(handle))
  assert.equal(card?.splitCharged, true)
  assert.notEqual(card?.paymentStatus, "paid")

  const [adj] = await sql<{ amount: string }[]>`
    SELECT amount FROM adjustments WHERE event = ${EVENT} AND customer = ${handle}`
  await sql`
    INSERT INTO payments (event, customer, amount, is_checked, kind)
    VALUES (${EVENT}, ${handle}, ${Number(adj.amount)}, true, 'deposit')`

  const after = await getShipOrdersFiltered({ event: EVENT })
  const settled = after.groups.find((g) => normalizeId(g.customer) === normalizeId(handle))
  assert.equal(settled?.paymentStatus, "paid")
  assert.equal(settled?.status, "split_requested", "still its own queue, now ready to pack")
})
