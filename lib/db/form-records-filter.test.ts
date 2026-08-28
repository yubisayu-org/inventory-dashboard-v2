import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { getDuplicateFormRowsPaginated } from "./orders"

const TAG = `frfilter${process.hrtime.bigint()}`
const EV = `${TAG}_EV`
const WHO = `${TAG}_c`

const page = (opts: Record<string, unknown>) =>
  getDuplicateFormRowsPaginated({ page: 1, pageSize: 50, event: EV, ...opts })

before(async () => {
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  await sql`INSERT INTO events (name, warehouse_id) SELECT ${EV}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`INSERT INTO customers (instagram_id) VALUES (${WHO})`
  const rows: [string, string][] = [
    // dispatch receipt, purchase receipt
    ["HC-2601", "chiko 25 mar"],
    ["HC/KS-2601", "31jan - sea"],
    ["HC/KS-2602", "tbo 31jan"],
    ["CJI-06", "readystock"],
  ]
  for (const [dispatch, receipt] of rows) {
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit, receipt, dispatch_receipt)
      VALUES (${EV}, ${WHO}, ${p.id}, 100000, 1, ${receipt}, ${dispatch})`
  }
})

after(async () => {
  await sql`DELETE FROM orders WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("a dispatch receipt matches from the front", async () => {
  // "HC" is the whole hand-carry route, HC/KS included.
  const hc = await page({ dispatchReceipt: "HC" })
  assert.equal(hc.rows.length, 3)

  // And a longer code narrows to its own boxes.
  const ks = await page({ dispatchReceipt: "HC/KS" })
  assert.equal(ks.rows.length, 2)
  assert.ok(ks.rows.every((r) => r.dispatchReceipt.startsWith("HC/KS")))

  const one = await page({ dispatchReceipt: "hc/ks-2602" })
  assert.equal(one.rows.length, 1, "case is ignored -- the code is typed by hand")
})

test("a dispatch receipt does not match mid-code", async () => {
  // Prefix, deliberately: "KS" is not a box, it is the tail of one.
  assert.equal((await page({ dispatchReceipt: "KS" })).rows.length, 0)
  assert.equal((await page({ dispatchReceipt: "2601" })).rows.length, 0)
})

test("a purchase receipt matches anywhere in it", async () => {
  // These are written however the trip was described, so the useful word is as
  // often in the middle: "31jan - sea", "tbo 31jan".
  assert.equal((await page({ receipt: "31jan" })).rows.length, 2)
  assert.equal((await page({ receipt: "sea" })).rows.length, 1)
  assert.equal((await page({ receipt: "chiko" })).rows.length, 1)
})

test("the two receipts filter independently", async () => {
  const both = await page({ dispatchReceipt: "HC/KS", receipt: "31jan" })
  assert.equal(both.rows.length, 2, "HC/KS boxes whose purchase receipt mentions 31jan")

  const none = await page({ dispatchReceipt: "CJI", receipt: "31jan" })
  assert.equal(none.rows.length, 0, "and they narrow, not widen")
})
