import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import {
  getCustomerPayments,
  getPayableBanks,
  submitCustomerPayment,
  rejectCustomerPayment,
  unrejectCustomerPayment,
} from "./catalogue-payments"
import { getPublicInvoiceForCustomer } from "./invoice"

// She reports what left her account; the shop confirms it against the bank.
// The whole safety of this rests on one thing: a reported payment is a claim,
// not money, until somebody ticks it.

const TAG = `paytest${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`

let customerId = 0
let handle = ""

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM payments WHERE customer = ${handle}`
  await sql`DELETE FROM orders WHERE customer = ${handle}`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id = ${customerId}`
  await sql`DELETE FROM events WHERE name LIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${TAG}%`}`
  await sql.end()
})

async function seed() {
  handle = `${TAG}_cust`
  const [c] = await sql<{ id: number }[]>`
    INSERT INTO customers (instagram_id) VALUES (${handle}) RETURNING id`
  customerId = c.id

  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
    VALUES (${EVENT}, ${handle}, ${p.id}, 250000, 2, 2)`
}

test("a reported payment lands unchecked, whatever it claims", async () => {
  await seed()
  const { id, amount } = await submitCustomerPayment({
    handle, event: EVENT, amount: 200000, bank: "BCA", sender: "Fandrian R",
  })
  assert.equal(amount, 200000)

  const [row] = await sql<{ is_checked: boolean; account: string; remarks: string }[]>`
    SELECT is_checked, account, remarks FROM payments WHERE id = ${id}`
  assert.equal(row.is_checked, false, "a claim is not money")
  assert.equal(row.account, "BCA")
  assert.equal(row.remarks, "Fandrian R", "the sending name is what gets matched in the statement")
})

// The invoice sums only checked rows, so an unchecked claim must leave the
// balance exactly where it was.
test("an unchecked claim moves no total", async () => {
  const { events } = await getPublicInvoiceForCustomer(handle, sql)
  const mine = events.find((e) => e.eventId === EVENT)
  assert.equal(mine?.invoice.pembayaran, 0)
  assert.ok((mine?.invoice.sisaPelunasan ?? 0) > 0)
})

test("she can report a second transfer before the first is checked", async () => {
  await submitCustomerPayment({
    handle, event: EVENT, amount: 50000, bank: "JAGO", sender: "Fandrian R",
  })
  const mine = await getCustomerPayments(handle)
  assert.equal(mine.length, 2, "a deposit today and the rest on payday is ordinary")
  assert.ok(mine.every((p) => p.status === "pending"))
})

test("nonsense is refused before it becomes a row someone has to hunt down", async () => {
  const bad = { handle, event: EVENT, bank: "BCA", sender: "Fandrian R" }
  await assert.rejects(() => submitCustomerPayment({ ...bad, amount: 0 }), /tidak valid/)
  await assert.rejects(() => submitCustomerPayment({ ...bad, amount: -5 }), /tidak valid/)
  await assert.rejects(() => submitCustomerPayment({ ...bad, amount: "abc" }), /tidak valid/)
  await assert.rejects(() => submitCustomerPayment({ ...bad, amount: 9_000_000_000 }), /terlalu besar/)
  await assert.rejects(
    () => submitCustomerPayment({ ...bad, amount: 1000, bank: "" }),
    /bank tujuan/,
  )
  await assert.rejects(
    () => submitCustomerPayment({ ...bad, amount: 1000, sender: "  " }),
    /nama rekening/,
  )
})

// Without this the endpoint would file a payment against any event name a
// caller invented, including one belonging to somebody else.
test("a payment can only be filed against a trip she actually ordered on", async () => {
  await assert.rejects(
    () => submitCustomerPayment({
      handle, event: `${TAG}_NOT_HERS`, amount: 1000, bank: "BCA", sender: "X",
    }),
    /tidak ditemukan/,
  )
})

test("refusing one leaves it exactly as she sent it, and tells her why", async () => {
  const mine = await getCustomerPayments(handle)
  const target = mine[0]
  await rejectCustomerPayment(target.id, "We cannot find that sender name.")

  const after = await getCustomerPayments(handle)
  const refused = after.find((p) => p.id === target.id)!
  assert.equal(refused.status, "rejected")
  assert.equal(refused.amount, target.amount, "the row is not edited, only marked")
  assert.equal(refused.bank, target.bank)
  assert.match(refused.reason, /sender name/)

  const [notice] = await sql<{ title: string; body: string }[]>`
    SELECT title, body FROM announcements WHERE customer_id = ${customerId} ORDER BY id DESC LIMIT 1`
  assert.match(notice.title, /could not confirm/i)
  assert.match(notice.body, /sender name/)
})

test("a refusal needs a reason, and cannot be given twice", async () => {
  const mine = await getCustomerPayments(handle)
  const refused = mine.find((p) => p.status === "rejected")!
  await assert.rejects(() => rejectCustomerPayment(refused.id, "   "), /Alasan/)
  await assert.rejects(() => rejectCustomerPayment(refused.id, "again"), /sudah ditolak/)
})

// A refused row is a decided one, so it must not sit in the unchecked queue.
test("a refused payment leaves the queue it was waiting in", async () => {
  const [{ n }] = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM payments
     WHERE customer = ${handle} AND is_checked = false AND rejected_at IS NULL`
  assert.equal(Number(n), 1, "only the claim still awaiting a decision")
})

test("a refusal can be taken back when the money turns up after all", async () => {
  const mine = await getCustomerPayments(handle)
  const refused = mine.find((p) => p.status === "rejected")!
  await unrejectCustomerPayment(refused.id)
  const after = await getCustomerPayments(handle)
  assert.equal(after.find((p) => p.id === refused.id)?.status, "pending")
})

// The account numbers she is shown come from the shop's own profile, so they
// cannot drift from the ones it publishes elsewhere.
test("the payable banks are parsed out of the shop's own profile", async () => {
  const { holder, banks } = await getPayableBanks()
  assert.ok(holder.length > 0)
  assert.ok(banks.length > 0)
  for (const b of banks) {
    assert.ok(b.label.length > 0, "a bank has a name")
    assert.match(b.number, /^[0-9]+$/, "and an account number with nothing else in it")
  }
})
