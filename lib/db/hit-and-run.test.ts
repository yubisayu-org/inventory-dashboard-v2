import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { cancelOrderUnits } from "./orders"
import { getHitAndRun } from "./hit-and-run"
import { hitAndRunStamp } from "../hit-and-run"

const TAG = `hrtest${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const WHO = `${TAG}_gone`
let productId = 0
const ids: number[] = []

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
  for (const note of ["minta size 110", ""]) {
    const [o] = await sql<{ id: number }[]>`
      INSERT INTO orders (event, customer, product_id, unit_price, unit, note)
      VALUES (${EVENT}, ${WHO}, ${productId}, 100000, 2, ${note}) RETURNING id`
    ids.push(o.id)
  }
})

after(async () => {
  await sql`DELETE FROM excess_purchase WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("the stamp names the trip and what she never paid", () => {
  assert.equal(hitAndRunStamp("LSKR202507", 710000), "HIT & RUN LSKR202507 Rp 710.000")
  // Nothing owed is not a negative loss.
  assert.equal(hitAndRunStamp("LSKR202507", -50), "HIT & RUN LSKR202507 Rp 0")
})

test("cancelling stamps the line without losing what was already written", async () => {
  const stamp = hitAndRunStamp(EVENT, 400000)
  for (const id of ids) {
    await cancelOrderUnits({ orderId: id, qty: 2, event: EVENT, productName: "x", stamp })
  }
  const rows = await sql<{ note: string }[]>`
    SELECT note FROM orders WHERE event = ${EVENT} ORDER BY id`
  assert.equal(rows[0].note, `minta size 110 · ${stamp}`, "appended, never replacing")
  assert.equal(rows[1].note, stamp, "an empty note gets the stamp alone")
})

test("she is found by the mark, once, however many lines carry it", async () => {
  const found = (await getHitAndRun()).filter((r) => r.customer === WHO.toLowerCase())
  assert.equal(found.length, 1, "one row per customer, not per line")
  assert.deepEqual(found[0].stamps, [hitAndRunStamp(EVENT, 400000)])
})

test("cancelling twice does not say it twice", async () => {
  const stamp = hitAndRunStamp(EVENT, 400000)
  // The lines are already at zero; re-running the stamp must be a no-op.
  await sql`UPDATE orders SET unit = 1 WHERE id = ${ids[1]}`
  await cancelOrderUnits({ orderId: ids[1], qty: 1, event: EVENT, productName: "x", stamp })
  const [row] = await sql<{ note: string }[]>`SELECT note FROM orders WHERE id = ${ids[1]}`
  assert.equal(row.note, stamp)
})

test("an unmarked customer is not in the list at all", async () => {
  const rows = await getHitAndRun()
  assert.ok(!rows.some((r) => r.customer === "" || r.stamps.length === 0))
})
