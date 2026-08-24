import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { createRefund } from "./finance"
import {
  getCustomerRefunds,
  chooseRefundCredit,
  chooseRefundBank,
} from "./catalogue-refunds"

// Money owed back, from her side. The whole safety of this is that she can
// move a refund between the two ways of receiving it and nowhere else — never
// to "refunded", which is a transfer that has already happened.

const TAG = `refundtest${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`
const OTHER = `${TAG}_other`

let handle = ""
let mine = 0
let theirs = 0

after(async () => {
  await sql`DELETE FROM refunds WHERE customer IN (${handle}, ${OTHER})`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

test("a refund reads back with its cause and its amount", async () => {
  handle = `${TAG}_cust`
  await sql`INSERT INTO customers (instagram_id) VALUES (${handle}), (${OTHER})`
  // refunds.event is a foreign key: a refund against a trip that does not
  // exist is not a state the shop can reach.
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`

  const created = await createRefund({
    event: EVENT, customer: handle, reason: "unavailable",
    refundAmount: 445000, note: "Laneige Water Sleeping Mask × 1",
  })
  mine = created.id

  const [row] = await getCustomerRefunds(handle)
  assert.equal(row.id, mine)
  assert.equal(row.amount, 445000)
  assert.equal(row.reason, "unavailable")
  assert.equal(row.status, "pending")
  assert.equal(row.note, "Laneige Water Sleeping Mask × 1")
})

test("keeping it on her account asks for nothing and stores nothing", async () => {
  await chooseRefundCredit(mine, handle)
  const [row] = await getCustomerRefunds(handle)
  assert.equal(row.status, "applied_to_next_order")
  assert.equal(row.bank, "", "a credit has no bank details to keep")
  assert.equal(row.accountMask, "")
})

test("she can change her mind, and the details land on the refund", async () => {
  await chooseRefundBank(mine, handle, {
    bank: "Bank Central Asia", accountNumber: "4419051991", accountHolder: "Fandrian R",
  })
  const [row] = await getCustomerRefunds(handle)
  assert.equal(row.status, "ready_to_refund")
  assert.equal(row.bank, "Bank Central Asia")
  assert.equal(row.accountHolder, "Fandrian R")

  // She typed it; she does not need it read back in full.
  assert.equal(row.accountMask, "••••••1991")
  assert.doesNotMatch(row.accountMask, /4419/)

  // And her profile is untouched: where one refund goes is a decision about
  // that refund, not a number to still be holding in six months.
  const [customer] = await sql<{ bank_account_number: string }[]>`
    SELECT bank_account_number FROM customers WHERE instagram_id = ${handle}`
  assert.equal(customer.bank_account_number ?? "", "")
})

test("an account number that is not one is refused", async () => {
  const ok = { bank: "BCA", accountHolder: "Fandrian R" }
  await assert.rejects(() => chooseRefundBank(mine, handle, { ...ok, accountNumber: "12345" }), /tidak valid/)
  await assert.rejects(() => chooseRefundBank(mine, handle, { ...ok, accountNumber: "abcdefgh" }), /tidak valid/)
  await assert.rejects(
    () => chooseRefundBank(mine, handle, { bank: "", accountNumber: "4419051991", accountHolder: "X" }),
    /Pilih bank/,
  )
  await assert.rejects(
    () => chooseRefundBank(mine, handle, { bank: "BCA", accountNumber: "4419051991", accountHolder: " " }),
    /nama pemilik/,
  )
})

// Spaces and dashes are how people write account numbers down.
test("a number written with spaces is stored as digits", async () => {
  await chooseRefundBank(mine, handle, {
    bank: "Bank Jago", accountNumber: "1033 8271-9370", accountHolder: "Fandrian R",
  })
  const [row] = await sql<{ bank_account_number: string }[]>`
    SELECT bank_account_number FROM refunds WHERE id = ${mine}`
  assert.equal(row.bank_account_number, "103382719370")
})

// The id is a number anyone could type. It is checked against her handle.
test("another customer's refund is not hers to move", async () => {
  const created = await createRefund({
    event: EVENT, customer: OTHER, reason: "goodwill", refundAmount: 50000,
  })
  theirs = created.id

  await assert.rejects(() => chooseRefundCredit(theirs, handle), /tidak ditemukan/)
  await assert.rejects(
    () => chooseRefundBank(theirs, handle, { bank: "BCA", accountNumber: "4419051991", accountHolder: "X" }),
    /tidak ditemukan/,
  )
  const [untouched] = await sql<{ status: string }[]>`SELECT status FROM refunds WHERE id = ${theirs}`
  assert.equal(untouched.status, "pending")

  // And it never appears on her page either.
  const hers = await getCustomerRefunds(handle)
  assert.ok(!hers.some((r) => r.id === theirs))
})

// A transfer that has already gone is not a choice any more.
test("a refund that has been sent cannot be moved", async () => {
  await sql`UPDATE refunds SET status = 'refunded' WHERE id = ${mine}`
  await assert.rejects(() => chooseRefundCredit(mine, handle), /sudah dikirim/)
  await assert.rejects(
    () => chooseRefundBank(mine, handle, { bank: "BCA", accountNumber: "4419051991", accountHolder: "X" }),
    /sudah dikirim/,
  )
})

test("a cancelled refund is off her page entirely", async () => {
  await sql`UPDATE refunds SET status = 'cancelled' WHERE id = ${mine}`
  const hers = await getCustomerRefunds(handle)
  assert.ok(!hers.some((r) => r.id === mine), "resolved overpayments are not news")
  await assert.rejects(() => chooseRefundCredit(mine, handle), /sudah ditutup/)
})
