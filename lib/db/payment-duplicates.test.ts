import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { findDuplicatePayment, findDuplicateForRow, DUPLICATE_WINDOW_DAYS } from "./payment-duplicates"

// The same transfer written down twice, and the one question that finds it
// wherever it came from: staff typing in what she already claimed, staff
// typing it twice, or her claiming it twice. It warns; it never refuses.

const TAG = `duptest${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const OTHER_EVENT = `${TAG}_EV2`
const TODAY = new Date().toISOString().slice(0, 10)

let handle = ""

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

after(async () => {
  await sql`DELETE FROM payments WHERE customer = ${handle}`
  await sql`DELETE FROM orders WHERE customer = ${handle}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

async function seed() {
  handle = `${TAG}_cust`
  await sql`INSERT INTO customers (instagram_id) VALUES (${handle})`
  for (const ev of [EVENT, OTHER_EVENT]) {
    await sql`
      INSERT INTO events (name, warehouse_id) SELECT ${ev}, id FROM warehouses ORDER BY id LIMIT 1`
  }
}

async function put(o: {
  event?: string
  amount: number
  payDate?: string
  checked?: boolean
  reportedBy?: "shop" | "customer"
  rejected?: boolean
}): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO payments (event, customer, amount, account, remarks, pay_date, kind,
                          is_checked, reported_by, rejected_at, reject_reason)
    VALUES (${o.event ?? EVENT}, ${handle}, ${o.amount}, 'BCA', 'Sari Dewi',
            ${o.payDate ?? TODAY}, 'deposit', ${o.checked ?? false},
            ${o.reportedBy ?? "shop"},
            ${o.rejected ? new Date() : null}, ${o.rejected ? "not found" : ""})
    RETURNING id`
  return row.id
}

test("the same money on the same trip is found, and says who wrote it down", async () => {
  await seed()
  await put({ amount: 185000, checked: true, reportedBy: "shop" })

  const hit = await findDuplicatePayment({
    customer: handle, event: EVENT, amount: 185000, payDate: TODAY,
  })
  assert.ok(hit, "a row for the same money on the same trip")
  assert.equal(hit.amount, 185000)
  assert.equal(hit.isChecked, true)
  assert.equal(hit.reportedBy, "shop")
  assert.equal(hit.remarks, "Sari Dewi", "the name a person recognises the row by")
})

test("a claim she filed herself is named as hers, so ticking it is on the table", async () => {
  await put({ amount: 100000, reportedBy: "customer" })
  const hit = await findDuplicatePayment({
    customer: handle, event: EVENT, amount: 100000, payDate: TODAY,
  })
  assert.equal(hit?.reportedBy, "customer")
  assert.equal(hit?.isChecked, false, "still waiting, which is what makes ticking the answer")
})

test("a different figure, a different trip, or an older date is a different payment", async () => {
  assert.equal(
    await findDuplicatePayment({ customer: handle, event: EVENT, amount: 185001, payDate: TODAY }),
    null,
    "one rupiah apart is not the same transfer",
  )
  assert.equal(
    await findDuplicatePayment({ customer: handle, event: OTHER_EVENT, amount: 185000, payDate: TODAY }),
    null,
    "the trip is part of the question — she may pay the same amount to two trips in a day",
  )
  assert.equal(
    await findDuplicatePayment({
      customer: handle, event: EVENT, amount: 185000, payDate: daysAgo(DUPLICATE_WINDOW_DAYS + 1),
    }),
    null,
    "far enough apart to be two transfers",
  )
  assert.ok(
    await findDuplicatePayment({
      customer: handle, event: EVENT, amount: 185000, payDate: daysAgo(DUPLICATE_WINDOW_DAYS),
    }),
    "the edge of the window is still inside it",
  )
})

test("a refused row took nothing, so it stands in nobody's way", async () => {
  await put({ amount: 77000, rejected: true })
  assert.equal(
    await findDuplicatePayment({ customer: handle, event: EVENT, amount: 77000, payDate: TODAY }),
    null,
  )
})

test("the checked row wins the match, because that is the one already counted", async () => {
  await put({ amount: 250000, checked: false, reportedBy: "customer" })
  const checkedId = await put({ amount: 250000, checked: true, reportedBy: "shop" })

  const hit = await findDuplicatePayment({
    customer: handle, event: EVENT, amount: 250000, payDate: TODAY,
  })
  assert.equal(hit?.id, checkedId, "the stronger warning is the money that already counts")
})

// The tick is where a claim turns into money, so the row being ticked must not
// be allowed to match itself.
test("a row about to be ticked never matches itself", async () => {
  const lonely = await put({ event: OTHER_EVENT, amount: 31000, reportedBy: "customer" })
  assert.equal(await findDuplicateForRow(lonely), null)

  const twin = await put({ event: OTHER_EVENT, amount: 31000, checked: true })
  const hit = await findDuplicateForRow(lonely)
  assert.equal(hit?.id, twin, "it finds the other one, not itself")
})
