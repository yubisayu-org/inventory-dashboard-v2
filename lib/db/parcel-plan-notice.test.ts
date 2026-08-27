import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { reconcileParcelPlan } from "./parcel-plan"

const TAG = "plannotice"
const EVENT = `${TAG}_EV`
const WHO = `${TAG}_c`
let customerId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`
    INSERT INTO products (name, store, gram, price)
    VALUES (${`${TAG} item`}, ${TAG}, 500, 0) RETURNING id`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${WHO}) RETURNING id`
  customerId = c.id
  await sql`
    INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
    SELECT ${c.id}, id, 25000 FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive)
    VALUES (${EVENT}, ${WHO}, ${p.id}, 100000, 2, 2, 2, 1)`
  await sql`
    INSERT INTO customer_shipping_prefs (customer_id, event, mode, set_by)
    VALUES (${customerId}, ${EVENT}, 'split', 'shop')`
})

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM adjustments WHERE event = ${EVENT}`
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ${customerId}`
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id = ${WHO}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql.end()
})

async function noticeCount(): Promise<number> {
  const [row] = (await sql`
    SELECT count(*)::int AS n FROM announcements WHERE customer_id = ${customerId}
  `) as unknown as { n: number }[]
  return row.n
}

test("a fee she must pay before shipping is announced", async () => {
  // She sees the number on her invoice either way. This is the only surface
  // that says why: the WhatsApp invoice lumps every adjustment into Biaya
  // Lainnya, and her catalogue page reads aggregates.
  await reconcileParcelPlan(WHO, EVENT)
  const [n] = (await sql`
    SELECT title, body FROM announcements
     WHERE customer_id = ${customerId} ORDER BY id DESC LIMIT 1`) as unknown as
    { title: string; body: string }[]
  assert.match(n.title, /Ongkir tambahan/)
  assert.match(n.title, new RegExp(EVENT))
  assert.match(n.body, /Rp 25\.000/)
})

test("an unchanged amount does not announce itself again", async () => {
  // It runs on every arrival. Saying the same thing four times is worse than
  // saying nothing.
  const before = await noticeCount()
  await reconcileParcelPlan(WHO, EVENT)
  await reconcileParcelPlan(WHO, EVENT)
  assert.equal(await noticeCount(), before)
})

test("no unresolved placeholder ever reaches her", async () => {
  const [n] = (await sql`
    SELECT title, body FROM announcements
     WHERE customer_id = ${customerId} ORDER BY id DESC LIMIT 1`) as unknown as
    { title: string; body: string }[]
  assert.doesNotMatch(`${n.title} ${n.body}`, /\{\w+\}/)
})
