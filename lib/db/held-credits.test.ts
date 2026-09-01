import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import catalogueSql from "../db-catalogue-public"
import { getHeldCredits } from "./catalogue-orders"

// Credits she chose to keep. The point of the test is the role: this runs on
// catalogue_public, whose grants are column-scoped, and a column nobody
// granted is invisible locally and a 500 in production.

const TAG = `heldtest${process.hrtime.bigint()}`
const HANDLE = `${TAG}_cust`
const EVENT = `${TAG}_EV`

after(async () => {
  await sql`DELETE FROM refunds WHERE customer = ${HANDLE}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id = ${HANDLE}`
  await sql.end()
  await catalogueSql.end()
})

/* reason matters to the fixture, not to the query. refunds_one_active_overpayment
   is a unique index on (event, customer) WHERE reason = 'overpayment' AND the
   status is still open, so the not-held rows below would collide with each
   other on one trip. They are goodwill refunds instead — getHeldCredits filters
   on status, and never looks at reason. */
async function refund(status: string, amount: number, event = EVENT, reason = "overpayment") {
  await sql`
    INSERT INTO refunds (event, customer, reason, refund_amount, status, note)
    VALUES (${event}, ${HANDLE}, ${reason}, ${amount}, ${status}, '')`
}

test("only the credits she is still holding come back, through the public role", async () => {
  await sql`INSERT INTO customers (instagram_id) VALUES (${HANDLE})`
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${`${TAG}_EV2`}, id FROM warehouses ORDER BY id LIMIT 1`

  await refund("applied_to_next_order", 213600)
  await refund("applied_to_next_order", 86400, `${TAG}_EV2`)
  // None of these is money she is holding.
  await refund("pending", 500000, EVENT, "goodwill")
  await refund("ready_to_refund", 500000, EVENT, "goodwill")
  await refund("refunded", 500000, EVENT, "goodwill")
  await refund("cancelled", 500000, EVENT, "goodwill")

  // catalogueSql, not sql: the grant is the thing under test.
  const held = await getHeldCredits(HANDLE, catalogueSql)
  assert.deepEqual(held.map((h) => h.amount), [213600, 86400])
  assert.deepEqual(held.map((h) => h.event), [EVENT, `${TAG}_EV2`])
  assert.equal(held.reduce((n, h) => n + h.amount, 0), 300000)
})

test("a zero credit is not something she is holding", async () => {
  await refund("applied_to_next_order", 0, `${TAG}_EV2`, "goodwill")
  const held = await getHeldCredits(HANDLE, catalogueSql)
  assert.ok(!held.some((h) => h.amount === 0))
})

test("somebody else's credits are not hers", async () => {
  assert.deepEqual(await getHeldCredits("someone-else-entirely", catalogueSql), [])
})
