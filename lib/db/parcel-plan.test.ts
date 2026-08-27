import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { planAdjustment, reconcileParcelPlan } from "./parcel-plan"

// ─── The pure part ───────────────────────────────────────────────────────────

test("a plan that costs nothing writes nothing", () => {
  // Rounding absorbs most splits. Silence is the correct output, not a zero row.
  assert.equal(planAdjustment(0, null), null)
})

test("an extra parcel is a fee, named for what it is", () => {
  assert.deepEqual(planAdjustment(25_000, null), {
    description: "Ongkir kirim duluan", amount: 25_000,
  })
})

test("a merge is a credit, named for the trip it merged with", () => {
  // The owner's own wording, kept: it says which trip, where "Diskon ongkir"
  // would leave her guessing weeks later.
  assert.deepEqual(planAdjustment(-14_000, "LSCN202606"), {
    description: "Gabung ongkir dengan LSCN202606", amount: -14_000,
  })
})

test("a credit with no partner named still says something useful", () => {
  assert.deepEqual(planAdjustment(-9_000, null), {
    description: "Diskon gabung ongkir", amount: -9_000,
  })
})

// ─── Against the database ────────────────────────────────────────────────────

const TAG = "planrec"
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
  // 1 kg in two halves, one arrived: split it and each parcel rounds up to
  // 1 kg, so the plan costs one extra kilo.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy, unit_dispatch, unit_arrive)
    VALUES (${EVENT}, ${WHO}, ${p.id}, 100000, 2, 2, 2, 1)`
})

after(async () => {
  await sql`DELETE FROM adjustments WHERE event = ${EVENT}`
  await sql`DELETE FROM customer_shipping_prefs WHERE customer_id = ${customerId}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ${customerId}`
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id = ${WHO}`
  await sql`DELETE FROM products WHERE name LIKE ${`${TAG}%`}`
  await sql.end()
})

async function autoRows(): Promise<{ description: string; amount: number }[]> {
  const rows = (await sql`
    SELECT description, amount::int AS amount FROM adjustments
     WHERE event = ${EVENT} AND auto ORDER BY id`) as unknown as
    { description: string; amount: number }[]
  // postgres.js hands back a Result, which deepEqual will not accept as an
  // array however identical its contents.
  return rows.map((r) => ({ description: r.description, amount: r.amount }))
}

async function setMode(mode: string) {
  await sql`
    INSERT INTO customer_shipping_prefs (customer_id, event, mode)
    VALUES (${customerId}, ${EVENT}, ${mode})
    ON CONFLICT (customer_id, event) DO UPDATE SET mode = ${mode}`
}

test("no declared plan means no row", async () => {
  await reconcileParcelPlan(WHO, EVENT)
  assert.deepEqual(await autoRows(), [])
})

test("declaring a split writes the fee", async () => {
  await setMode("split")
  await reconcileParcelPlan(WHO, EVENT)
  assert.deepEqual(await autoRows(), [{ description: "Ongkir kirim duluan", amount: 25000 }])
})

test("running it again changes nothing", async () => {
  // Idempotence is the whole contract: it runs on every arrival and every
  // press, and must never stack rows or double an amount.
  await reconcileParcelPlan(WHO, EVENT)
  await reconcileParcelPlan(WHO, EVENT)
  assert.deepEqual(await autoRows(), [{ description: "Ongkir kirim duluan", amount: 25000 }])
})

test("clearing the plan removes the row", async () => {
  await setMode("wait")
  await reconcileParcelPlan(WHO, EVENT)
  assert.deepEqual(await autoRows(), [])
})

test("a row somebody typed is invisible to it, even worded identically", async () => {
  // The reason adjustments.auto exists. This row must survive untouched.
  await sql`
    INSERT INTO adjustments (event, customer, description, amount, auto)
    VALUES (${EVENT}, ${WHO}, 'Ongkir kirim duluan', 99000, false)`
  await setMode("split")
  await reconcileParcelPlan(WHO, EVENT)
  const [mine] = (await sql`
    SELECT amount::int AS amount FROM adjustments
     WHERE event = ${EVENT} AND NOT auto`) as unknown as { amount: number }[]
  assert.equal(mine.amount, 99000, "the owner's row was rewritten")
  assert.deepEqual(await autoRows(), [{ description: "Ongkir kirim duluan", amount: 25000 }])
})
