import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { reconcileParcelPlan } from "./parcel-plan"

// hanapanjaitan's shape, from production. 1.390 g on one trip and 100 g on
// another: invoiced as 2 kg + 1 kg, but one box weighs 1.490 g and the courier
// bills 2 kg. One kilo saved, Rp 14.000 — once.
const TAG = `mergeonce${process.hrtime.bigint()}`
const A = `${TAG}_AEV`
const B = `${TAG}_BEV`
const C = `${TAG}_CEV`
const WHO = `${TAG}_c`
const RATE = 14_000
let customerId = 0
let bigId = 0
let smallId = 0

async function adjustments() {
  return await sql<{ event: string; amount: number; description: string }[]>`
    SELECT event, amount::int AS amount, description FROM adjustments
     WHERE customer = ${WHO} AND auto ORDER BY event`
}

before(async () => {
  const [big] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price) VALUES (${`${TAG} big`}, ${TAG}, 1390, 0) RETURNING id`
  const [small] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price) VALUES (${`${TAG} small`}, ${TAG}, 100, 0) RETURNING id`
  bigId = big.id
  smallId = small.id
  for (const e of [A, B, C]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
  }
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${WHO}) RETURNING id`
  customerId = c.id
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
    SELECT ${c.id}, id, ${RATE} FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy)
    VALUES (${A}, ${WHO}, ${bigId}, 100000, 1, 1)`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy)
    VALUES (${B}, ${WHO}, ${smallId}, 100000, 1, 1)`
})

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM payments WHERE customer = ${WHO}`
  await sql`DELETE FROM adjustments WHERE customer = ${WHO}`
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ${customerId}`
  await sql`DELETE FROM orders WHERE customer = ${WHO}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id = ${WHO}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql.end()
})

async function pair(events: string[]) {
  const key = `${TAG}-grp`
  for (const e of events) {
    await sql`
      INSERT INTO customer_shipping_prefs (customer_id, event, mode, set_by, merge_key)
      VALUES (${customerId}, ${e}, 'wait', 'customer', ${key})
      ON CONFLICT (customer_id, event) DO UPDATE SET merge_key = ${key}`
  }
}

test("a merge gives the saving back on the cheapest trip, once", async () => {
  // 2 kg + 1 kg invoiced, one 1.490 g box billed as 2 kg. The saving is one
  // kilo, and it is given back by cancelling a whole delivery charge rather
  // than piling the figure onto one trip: B's own kilo goes, A keeps the two
  // the box actually cost. Written on both trips it was two kilos.
  await pair([A, B])
  for (const e of [A, B]) await reconcileParcelPlan(WHO, e)

  const rows = await adjustments()
  assert.equal(rows.length, 1, "one credit for one saving")
  assert.equal(rows[0].event, B, "on the cheaper trip, whose whole charge it cancels")
  assert.equal(rows[0].amount, -RATE)
  assert.match(rows[0].description, new RegExp(A), "and it says which trip it merged with")
})

test("reconciling the other trip does not add a second", async () => {
  // Every arrival on either trip runs this. It must stay at one however often
  // it is asked.
  for (const e of [B, A, B]) await reconcileParcelPlan(WHO, e)
  assert.equal((await adjustments()).length, 1)
})

test("a duplicate already on the books is cleared", async () => {
  // The production repair path: hanapanjaitan carried one of these on each
  // trip. Reconciling the trip that should not hold one deletes it.
  await sql`
    INSERT INTO adjustments (event, customer, description, amount, auto)
    VALUES (${A}, ${WHO}, ${`Gabung ongkir dengan ${B}`}, ${-RATE}, true)`
  assert.equal((await adjustments()).length, 2, "planted")

  await reconcileParcelPlan(WHO, A)
  const rows = await adjustments()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event, B, "the trip that keeps the box's charge holds no credit")
})

test("a three-trip merge gives back exactly what it saved, and no more", async () => {
  // 2 + 1 + 1 invoiced = 4 kg; one box of 1.590 g = 2 kg. Two kilos saved,
  // and the two cheap trips are the ones that stop paying — so what is still
  // charged across the group is the two kilos the box really cost.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy)
    VALUES (${C}, ${WHO}, ${smallId}, 100000, 1, 1)`
  await pair([A, B, C])
  for (const e of [A, B, C]) await reconcileParcelPlan(WHO, e)

  const rows = await adjustments()
  const total = rows.reduce((n, r) => n + Number(r.amount), 0)
  assert.equal(total, -2 * RATE, "the saving, once")
  assert.equal(rows.length, 2, "one whole charge cancelled on each cheap trip")
  assert.deepEqual(rows.map((r) => r.event).sort(), [B, C].sort(), "and never on the trip paying for the box")
  // Which is the point of crediting where it was charged: no invoice is left
  // showing a total below the goods on it.
  for (const r of rows) assert.equal(Number(r.amount), -RATE)
})

test("unpairing takes the credit away with it", async () => {
  await sql`
    UPDATE customer_shipping_prefs SET merge_key = NULL WHERE customer_id = ${customerId}`
  for (const e of [A, B, C]) await reconcileParcelPlan(WHO, e)
  assert.equal((await adjustments()).length, 0)
})

// The wrinkle: the saving is smaller than any single trip's charge, so a whole
// charge cannot be cancelled without giving back more than was saved.
test("where no whole charge fits, the cheapest trip is credited in part", async () => {
  await sql`UPDATE customer_shipping_prefs SET merge_key = NULL WHERE customer_id = ${customerId}`
  await sql`DELETE FROM adjustments WHERE customer = ${WHO}`
  await sql`DELETE FROM orders WHERE customer = ${WHO}`

  // Two trips of 1.200 g: each invoiced as 2 kg, one box of 2.400 g as 3 kg.
  // Charged 4 kg, box is 3 — one kilo saved, and neither trip's charge is
  // one kilo.
  const [mid] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price) VALUES (${`${TAG} mid`}, ${TAG}, 1200, 0)
    RETURNING id`
  for (const e of [A, B]) {
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy)
      VALUES (${e}, ${WHO}, ${mid.id}, 100000, 1, 1)`
  }
  await pair([A, B])
  for (const e of [A, B]) await reconcileParcelPlan(WHO, e)

  const rows = await adjustments()
  assert.equal(rows.length, 1, "one credit")
  assert.equal(rows[0].amount, -RATE, "the kilo that was saved, not the two it was charged")
  // Still only ever a discount: no invoice is handed a charge it did not have.
  assert.ok(rows.every((r) => Number(r.amount) < 0))
})

// taleofblackcats, in miniature. She settled one trip in full — delivery
// included — months before the second existed. One box owes one delivery, and
// that money is already inside the payment she made, so the trip she has not
// paid it on is the one that stops charging for it.
test("the discount lands where she has not already paid the delivery", async () => {
  await sql`UPDATE customer_shipping_prefs SET merge_key = NULL WHERE customer_id = ${customerId}`
  await sql`DELETE FROM adjustments WHERE customer = ${WHO}`
  await sql`DELETE FROM payments WHERE customer = ${WHO}`
  await sql`DELETE FROM orders WHERE customer = ${WHO}`

  // Two trips of the same weight, so the charges tie and nothing but her
  // payments can decide which keeps it.
  for (const e of [A, B]) {
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy)
      VALUES (${e}, ${WHO}, ${smallId}, 100000, 1, 1)`
  }

  // A is paid in full: goods and delivery. B is paid for its goods alone.
  await sql`
    INSERT INTO payments (event, customer, amount, account, is_checked, kind)
    VALUES (${A}, ${WHO}, ${100000 + RATE}, 'BCA', true, 'deposit')`
  await sql`
    INSERT INTO payments (event, customer, amount, account, is_checked, kind)
    VALUES (${B}, ${WHO}, 100000, 'BCA', true, 'deposit')`

  await pair([A, B])
  for (const e of [A, B]) await reconcileParcelPlan(WHO, e)

  const rows = await adjustments()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].event, B, "B stops charging for a delivery she paid on A")
  assert.equal(rows[0].amount, -RATE)

  // Which is the whole point: both trips close, and nobody has to move
  // Rp 50.000 from one invoice to the other by hand.
  const balances = await sql<{ event: string; balance: number }[]>`
    SELECT event, balance FROM live_balances WHERE customer = ${WHO} ORDER BY event`
  for (const b of balances) assert.equal(Number(b.balance), 0, `${b.event} settles`)
})
