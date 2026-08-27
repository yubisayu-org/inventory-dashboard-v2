import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { reconcileParcelPlan } from "./parcel-plan"

const TAG = "inflight"
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
  // 1 kg in two halves, one arrived: splitting costs a whole extra kilo.
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

async function fee(): Promise<number | null> {
  const [row] = (await sql`
    SELECT amount::int AS amount FROM adjustments
     WHERE event = ${EVENT} AND auto LIMIT 1`) as unknown as { amount: number }[]
  return row?.amount ?? null
}
const setMode = (mode: string) => sql`
  UPDATE customer_shipping_prefs SET mode = ${mode} WHERE customer_id = ${customerId}`

test("before anything ships, cancelling the split takes the fee with it", async () => {
  await reconcileParcelPlan(WHO, EVENT)
  assert.equal(await fee(), 25000)

  await setMode("wait")
  await reconcileParcelPlan(WHO, EVENT)
  assert.equal(await fee(), null, "nothing has travelled, so nothing was owed")
})

test("once the early box has gone, the fee survives cancelling", async () => {
  // The bug this exists for. The parcel travelled and was paid for at the
  // price agreed then; the reconciler prices what is true now, and a shipped
  // box is not in "now".
  await setMode("split")
  await reconcileParcelPlan(WHO, EVENT)
  assert.equal(await fee(), 25000)

  await sql`UPDATE orders SET unit_ship = 1 WHERE event = ${EVENT}`
  await setMode("wait")
  await reconcileParcelPlan(WHO, EVENT)
  assert.equal(await fee(), 25000, "the shop paid a courier for a journey that happened")
})

test("it holds at the same figure however often it is recomputed", async () => {
  // Every arrival reconciles, and a shipped plan reconciles to less than it
  // was charged — so "never downwards" has to survive being asked repeatedly,
  // not just once.
  for (let i = 0; i < 3; i++) await reconcileParcelPlan(WHO, EVENT)
  assert.equal(await fee(), 25000)
})

test("a split declared after the first box has left prices nothing", async () => {
  // Not a bug to fix here, but the shape of what this can know. The arithmetic
  // reads the orders as they stand, and a parcel that has gone is not in them:
  // one box left, one remainder pending, one parcel to price. Declaring a
  // split now describes something that has already happened.
  //
  // It fails safe — the shop under-charges rather than billing for a journey
  // twice — and the fee written when the split WAS declared is protected by
  // the rule above.
  await sql`DELETE FROM adjustments WHERE event = ${EVENT} AND auto`
  await setMode("split")
  await reconcileParcelPlan(WHO, EVENT)
  assert.equal(await fee(), null)
})
