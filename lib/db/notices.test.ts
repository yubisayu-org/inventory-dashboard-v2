import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { sendInvoiceNotice } from "./notices"
import { fillNotice, unknownTokens, NOTICE_TEMPLATES, REFUND_CAUSES } from "../notice-templates"

// Telling one customer one thing about one trip — and, when the thing is a
// refund, creating the refund in the same breath.

const TAG = `noticetest${process.hrtime.bigint()}`
const EVENT = `${TAG}_EV`

let customerId = 0
let handle = ""

after(async () => {
  await sql`DELETE FROM announcements WHERE customer_id = ${customerId}`
  await sql`DELETE FROM refunds WHERE customer = ${handle}`
  await sql`DELETE FROM orders WHERE customer = ${handle}`
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

// ── the wording, on its own ──────────────────────────────────────
test("placeholders resolve from the trip, and unknown ones are left alone", () => {
  const filled = fillNotice("{event} · {outstanding} due", {
    "{event}": "LSKR202511",
    "{outstanding}": "Rp 1.320.000",
  })
  assert.equal(filled, "LSKR202511 · Rp 1.320.000 due")

  // Left as written rather than blanked: blanking hides the typo and sends a
  // sentence with a hole in it.
  assert.equal(fillNotice("Hello {nope}", {}), "Hello {nope}")
  assert.deepEqual(unknownTokens("Hello {nope} and {event}"), ["{nope}"])
  assert.deepEqual(unknownTokens("All {event} fine"), [])
})

test("every template's tokens are ones we can actually resolve", () => {
  for (const t of NOTICE_TEMPLATES) {
    assert.deepEqual(unknownTokens(`${t.title} ${t.body}`), [], `${t.key} has an unknown token`)
  }
  for (const c of REFUND_CAUSES) {
    assert.deepEqual(unknownTokens(c.line), [], `${c.key} has an unknown token`)
  }
})

// ── sending ──────────────────────────────────────────────────────
test("a plain notice lands in her inbox and creates no refund", async () => {
  await seed()
  const { refundId } = await sendInvoiceNotice({
    event: EVENT, customer: handle,
    title: `${EVENT} is running late`,
    body: "The trip has been pushed back.",
  })
  assert.equal(refundId, null)

  const [notice] = await sql<{ title: string; customer_id: number }[]>`
    SELECT title, customer_id FROM announcements WHERE customer_id = ${customerId}`
  assert.match(notice.title, new RegExp(EVENT))
  assert.equal(notice.customer_id, customerId, "aimed at her, not broadcast")
})

test("a refund notice creates the refund it announces", async () => {
  const { refundId } = await sendInvoiceNotice({
    event: EVENT, customer: handle,
    title: "Rp 250.000 is coming back to you",
    body: "We could not buy it. That is Rp 250.000 owed back to you.",
    refund: { cause: "unavailable", amount: 250000, affectedUnits: 1, items: "Something × 1" },
  })
  assert.ok(refundId)

  const [row] = await sql<{ reason: string; refund_amount: number; note: string; status: string }[]>`
    SELECT reason, refund_amount, note, status FROM refunds WHERE id = ${refundId!}`
  assert.equal(row.reason, "unavailable", "the same word her card will say later")
  assert.equal(Number(row.refund_amount), 250000)
  assert.equal(row.note, "Something × 1")
  assert.equal(row.status, "pending")
})

// A promise nothing records is only as good as somebody remembering it.
test("a refund with no amount is refused, and nothing is sent", async () => {
  const before = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM announcements WHERE customer_id = ${customerId}`
  await assert.rejects(() => sendInvoiceNotice({
    event: EVENT, customer: handle, title: "x", body: "y",
    refund: { cause: "goodwill", amount: 0 },
  }), /needs an amount/)

  const after = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM announcements WHERE customer_id = ${customerId}`
  assert.equal(after[0].n, before[0].n, "no notice went out either")
})

test("a reason the refunds table does not know is refused", async () => {
  await assert.rejects(() => sendInvoiceNotice({
    event: EVENT, customer: handle, title: "x", body: "y",
    refund: { cause: "because_i_said_so", amount: 1000 },
  }), /Unknown refund reason/)
})

test("a mistyped placeholder stops the whole thing", async () => {
  await assert.rejects(() => sendInvoiceNotice({
    event: EVENT, customer: handle,
    title: "About {evnt}", body: "Something happened.",
  }), /not a placeholder/)
})

test("a notice with no words is refused", async () => {
  await assert.rejects(
    () => sendInvoiceNotice({ event: EVENT, customer: handle, title: "  ", body: "y" }),
    /title and a message/,
  )
})
