import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { outstandingElsewhere, outstandingByCustomer } from "./outstanding-elsewhere"

const TAG = `owetest${process.hrtime.bigint()}`.toLowerCase()
const HERE = `${TAG}_here`
const THERE = `${TAG}_there`
const MORE = `${TAG}_more`
const WHO = `${TAG}_cust`
let productId = 0

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products WHERE COALESCE(gram,0) = 0 ORDER BY id LIMIT 1`
  productId = p.id
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
  for (const e of [HERE, THERE, MORE]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
  }
  // Owed here (overpaid), owing on the other two.
  await sql`INSERT INTO orders (event, customer, product_id, unit_price, unit) VALUES (${HERE},${WHO},${productId},100000,1)`
  await sql`INSERT INTO payments (event, customer, amount, is_checked, kind) VALUES (${HERE},${WHO},160000,true,'deposit')`
  await sql`INSERT INTO orders (event, customer, product_id, unit_price, unit) VALUES (${THERE},${WHO},${productId},300000,1)`
  await sql`INSERT INTO orders (event, customer, product_id, unit_price, unit) VALUES (${MORE},${WHO},${productId},80000,1)`
})

after(async () => {
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("the trips they owe on, largest first", async () => {
  const rows = await outstandingElsewhere(WHO, HERE)
  assert.deepEqual(rows.map((r) => [r.event, r.amount]), [[THERE, 300000], [MORE, 80000]])
})

test("the trip being refunded is never offered back to itself", async () => {
  const rows = await outstandingElsewhere(WHO, HERE)
  assert.equal(rows.find((r) => r.event === HERE), undefined)
})

test("a trip they have settled is not listed", async () => {
  await sql`INSERT INTO payments (event, customer, amount, is_checked, kind) VALUES (${MORE},${WHO},80000,true,'deposit')`
  const rows = await outstandingElsewhere(WHO, HERE)
  assert.equal(rows.find((r) => r.event === MORE), undefined, "nothing owed, nothing to offer")
  await sql`DELETE FROM payments WHERE event = ${MORE}`
})

test("a customer who owes nowhere gets an empty list", async () => {
  assert.deepEqual(await outstandingElsewhere(`${TAG}_nobody`, HERE), [])
})

test("every customer's debts in one pass, for a whole list of refunds", async () => {
  // One query for the page, not one per row: the refunds list can be long and
  // each lookup would otherwise re-aggregate every invoice in the shop.
  const all = await outstandingByCustomer()
  const mine = all[WHO]
  assert.ok(mine, "the customer is keyed by their normalized handle")
  assert.deepEqual(mine.map((t) => [t.event, t.amount]), [[THERE, 300000], [MORE, 80000]])
})
