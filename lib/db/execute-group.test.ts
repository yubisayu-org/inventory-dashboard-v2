import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { executeRefundGroup, getRefunds } from "./finance"

const TAG = `paytogether${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const OTHER = `${TAG}_EV2`
const WHO = `${TAG}_c`
const ELSE = `${TAG}_other`

async function refund(event: string, customer: string, reason: string, amount: number, status = "ready_to_refund") {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status,
                         bank_name, bank_account_number, bank_account_holder)
    VALUES (${event}, ${customer}, ${reason}, ${amount}, ${status},
            'BCA', '1234567890', 'Her Name') RETURNING id`
  return r.id
}

before(async () => {
  for (const e of [EVENT, OTHER]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${e}, id FROM warehouses ORDER BY id LIMIT 1`
  }
  for (const c of [WHO, ELSE]) await sql`INSERT INTO customers (instagram_id) VALUES (${c})`
})

after(async () => {
  await sql`DELETE FROM payments WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM refunds WHERE event LIKE ${`${TAG}%`}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("three refunds, one transfer, three payment rows", async () => {
  // The rows stay split because each is its own explanation. The link from
  // payment to refund is what undo, the audit trail and every per-reason total
  // are built on, so one merged payment would buy nothing and break all three.
  const a = await refund(EVENT, WHO, "unavailable", 160000)
  const b = await refund(EVENT, WHO, "shipping_loss", 200000)
  const c = await refund(EVENT, WHO, "damaged", 100000, "pending")

  const res = await executeRefundGroup([a, b, c], "TRF-1", "BCA", "tester")
  assert.equal(res.total, 460000)
  assert.equal(res.paid.length, 3)

  const rows = await getRefunds({ event: EVENT })
  assert.ok(rows.every((r) => r.status === "refunded"), "all three settled")
  assert.ok(rows.every((r) => r.transferReference === "TRF-1"), "one reference")
  // The pending one had no bank details of its own; it inherits the account the
  // money actually went to.
  assert.ok(rows.every((r) => r.bankAccountNumber === "1234567890"))

  const pays = await sql<{ refund_id: number; amount: number; remarks: string }[]>`
    SELECT refund_id, amount::int, remarks FROM payments
     WHERE event = ${EVENT} ORDER BY refund_id`
  assert.equal(pays.length, 3, "one payment per refund, not one for the lot")
  assert.deepEqual(pays.map((p) => p.amount).sort((x, y) => x - y), [-200000, -160000, -100000])
  assert.match(pays.find((p) => p.refund_id === b)!.remarks, /shipping_loss/)
})

test("an unticked refund is simply not in the group", async () => {
  const a = await refund(EVENT, WHO, "quality", 50000)
  const left = await refund(EVENT, WHO, "goodwill", 25000)

  await executeRefundGroup([a], "TRF-2", "BCA", "tester")
  const [row] = await sql<{ status: string }[]>`SELECT status FROM refunds WHERE id = ${left}`
  assert.equal(row.status, "ready_to_refund", "still waiting, untouched")
})

test("a group spanning two trips is refused whole", async () => {
  const here = await refund(EVENT, WHO, "unavailable", 10000)
  const there = await refund(OTHER, WHO, "unavailable", 10000)
  await assert.rejects(
    () => executeRefundGroup([here, there], "TRF-3", "BCA", "tester"),
    /same customer on the same trip/,
  )
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM refunds WHERE id IN (${here}, ${there})`
  assert.ok(rows.every((r) => r.status === "ready_to_refund"), "nothing was paid")
})

test("a group spanning two customers is refused whole", async () => {
  const hers = await refund(EVENT, WHO, "damaged", 10000)
  const theirs = await refund(EVENT, ELSE, "damaged", 10000)
  await assert.rejects(
    () => executeRefundGroup([hers, theirs], "TRF-4", "BCA", "tester"),
    /same customer on the same trip/,
  )
})

test("a refund already sent stops the whole group", async () => {
  // Finding out afterwards that one of them went twice is worse than not
  // starting.
  const done = await refund(EVENT, WHO, "quality", 10000, "refunded")
  const open = await refund(EVENT, WHO, "quality", 20000)
  await assert.rejects(
    () => executeRefundGroup([open, done], "TRF-5", "BCA", "tester"),
    /already been sent/,
  )
  const [row] = await sql<{ status: string }[]>`SELECT status FROM refunds WHERE id = ${open}`
  assert.equal(row.status, "ready_to_refund")
})

test("the bank details come from the row that was open, not the lowest id", async () => {
  const older = await refund(EVENT, WHO, "unavailable", 10000)
  const [open] = await sql<{ id: number }[]>`
    INSERT INTO refunds (event, customer, reason, refund_amount, status,
                         bank_name, bank_account_number, bank_account_holder)
    VALUES (${EVENT}, ${WHO}, 'damaged', 20000, 'ready_to_refund',
            'JAGO', '999', 'Checked Against Her Message') RETURNING id`

  await executeRefundGroup([open.id, older], "TRF-6", "BCA", "tester")
  const [stamped] = await sql<{ bank_account_number: string }[]>`
    SELECT bank_account_number FROM refunds WHERE id = ${older}`
  assert.equal(stamped.bank_account_number, "999")
})
