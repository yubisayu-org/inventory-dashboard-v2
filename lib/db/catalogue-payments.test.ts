import { test, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import {
  DuplicateClaimError,
  getCustomerPayments,
  getPayableBanks,
  getQrisOffer,
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
  // business_profile is one shared row, and these tests move its QRIS
  // settings about. Put them back the way they were found.
  await sql`
    UPDATE business_profile
       SET qris_enabled = ${QRIS_WAS.enabled}, qris_image_url = ${QRIS_WAS.image},
           qris_max_per_payment = ${QRIS_WAS.perPayment}, qris_max_per_order = ${QRIS_WAS.perOrder},
           qris_max_per_year = ${QRIS_WAS.perYear}
     WHERE id = 1`
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


// ─── QRIS ────────────────────────────────────────────────────────────────────
//
// A second way to pay, with three ceilings that each do a different job. The
// browser greys the button; these are the checks that actually hold, because
// the amount is the customer's own field on her own machine.

const QRIS_WAS = { enabled: false, image: "", perPayment: 0, perOrder: 0, perYear: 0 }

const QRIS_EVENT = `${TAG}_QR`

/** Puts the shop's QRIS settings where a test needs them. */
async function setQris(o: {
  enabled?: boolean
  image?: string
  perPayment?: number
  perOrder?: number
  perYear?: number
}) {
  await sql`
    UPDATE business_profile
       SET qris_enabled = ${o.enabled ?? true},
           qris_image_url = ${o.image ?? "https://example.test/storage/v1/object/public/catalogue-media/qris/x.png"},
           qris_merchant_name = 'YUBISAYU STORE',
           qris_max_per_payment = ${o.perPayment ?? 0},
           qris_max_per_order = ${o.perOrder ?? 0},
           qris_max_per_year = ${o.perYear ?? 0}
     WHERE id = 1`
}

/** What the shop has already taken through QRIS in this database, so a yearly
 *  test can set its ceiling relative to reality rather than assume an empty
 *  table. */
async function qrisYearSoFar(): Promise<number> {
  const [row] = await sql<{ total: string | null }[]>`
    SELECT SUM(amount) AS total FROM payments
     WHERE account = 'QRIS' AND kind = 'deposit' AND is_checked AND rejected_at IS NULL
       AND pay_date >= CURRENT_DATE - INTERVAL '12 months'`
  return Number(row?.total ?? 0)
}

test("QRIS is only offered once there is a QR to scan", async () => {
  // Remember what was there before the first test moves it.
  const [was] = await sql<{
    qris_enabled: boolean; qris_image_url: string
    qris_max_per_payment: string; qris_max_per_order: string; qris_max_per_year: string
  }[]>`SELECT qris_enabled, qris_image_url, qris_max_per_payment, qris_max_per_order,
              qris_max_per_year FROM business_profile WHERE id = 1`
  QRIS_WAS.enabled = was.qris_enabled
  QRIS_WAS.image = was.qris_image_url
  QRIS_WAS.perPayment = Number(was.qris_max_per_payment)
  QRIS_WAS.perOrder = Number(was.qris_max_per_order)
  QRIS_WAS.perYear = Number(was.qris_max_per_year)

  await setQris({ enabled: true, image: "" })
  assert.equal(await getQrisOffer(), null, "switched on with nothing to show is still nothing")

  await setQris({ enabled: false })
  assert.equal(await getQrisOffer(), null)

  await setQris({ enabled: true, perPayment: 100000, perOrder: 300000 })
  const offer = await getQrisOffer()
  assert.ok(offer)
  assert.equal(offer.maxPerPayment, 100000)
  assert.equal(offer.maxPerOrder, 300000)
  assert.equal(offer.merchantName, "YUBISAYU STORE")
  // The year's figures are the shop's business, not hers.
  assert.equal("maxPerYear" in offer, false)
})

test("the per-payment ceiling includes the ceiling itself", async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${QRIS_EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
    VALUES (${QRIS_EVENT}, ${handle}, ${p.id}, 400000, 1, 1)`

  await setQris({ perPayment: 100000, perOrder: 300000 })

  await assert.rejects(
    () => submitCustomerPayment({
      handle, event: QRIS_EVENT, amount: 100001, bank: "QRIS", sender: "Sari",
    }),
    /sampai Rp 100.000/,
    "one rupiah over is over",
  )

  const { id } = await submitCustomerPayment({
    handle, event: QRIS_EVENT, amount: 100000, bank: "qris", sender: "Sari",
  })
  const [row] = await sql<{ account: string }[]>`SELECT account FROM payments WHERE id = ${id}`
  assert.equal(row.account, "QRIS", "however she spells it, it is stored the way the shop does")
})

// The hole a per-payment ceiling leaves on its own: the amount is hers to
// edit, so an order goes through in small scans and no single claim ever
// breaks a rule.
test("scans on one order are added up, and a refusal gives the room back", async () => {
  await setQris({ perPayment: 100000, perOrder: 150000 })

  await assert.rejects(
    () => submitCustomerPayment({
      handle, event: QRIS_EVENT, amount: 100000, bank: "QRIS", sender: "Sari",
    }),
    /sudah lewat QRIS/,
    "100.000 is already on this order, so another 100.000 is over its 150.000",
  )

  const { id } = await submitCustomerPayment({
    handle, event: QRIS_EVENT, amount: 50000, bank: "QRIS", sender: "Sari",
  })

  // A claim nobody has ticked still holds its space — otherwise three scans in
  // one minute all pass, none of them having been checked yet.
  await assert.rejects(
    () => submitCustomerPayment({
      handle, event: QRIS_EVENT, amount: 1000, bank: "QRIS", sender: "Sari",
    }),
    /sudah lewat QRIS/,
  )

  await rejectCustomerPayment(id, "Not found in the QRIS report.")
  const { id: retried } = await submitCustomerPayment({
    handle, event: QRIS_EVENT, amount: 50000, bank: "QRIS", sender: "Sari",
  })
  assert.ok(retried, "a refusal took nothing, so it holds no room")

  // A bank transfer is not QRIS money and never counted against it.
  const { id: byBank } = await submitCustomerPayment({
    handle, event: QRIS_EVENT, amount: 250000, bank: "BCA", sender: "Sari",
  })
  assert.ok(byBank)
})

test("the year's ceiling closes the offer, counting what staff typed in too", async () => {
  const soFar = await qrisYearSoFar()

  // A payment the shop recorded itself, verified — the shop's QRIS turnover
  // just as much as a customer's claim.
  await sql`
    INSERT INTO payments (event, customer, amount, account, remarks, pay_date, kind, is_checked)
    VALUES (${QRIS_EVENT}, ${handle}, 40000, 'QRIS', 'entered by staff', CURRENT_DATE, 'deposit', true)`

  await setQris({ perPayment: 100000, perOrder: 300000, perYear: soFar + 40000 })
  assert.equal(await getQrisOffer(), null, "the year is spent, so nothing is offered")

  await assert.rejects(
    () => submitCustomerPayment({
      handle, event: QRIS_EVENT, amount: 1000, bank: "QRIS", sender: "Sari",
    }),
    /tidak tersedia/,
    "and the reason she is given says nothing about the shop's turnover",
  )

  await setQris({ perPayment: 100000, perOrder: 300000, perYear: soFar + 40000 + 100000 })
  assert.ok(await getQrisOffer(), "room again once the ceiling is raised")
})

test("with every ceiling empty, QRIS is simply open", async () => {
  await setQris({ perPayment: 0, perOrder: 0, perYear: 0 })
  const offer = await getQrisOffer()
  assert.ok(offer)
  assert.equal(offer.maxPerPayment, 0, "0 is how the sheet is told there is no ceiling")

  const { id } = await submitCustomerPayment({
    handle, event: QRIS_EVENT, amount: 5000000, bank: "QRIS", sender: "Sari",
  })
  assert.ok(id)
})


// ─── Claiming the same transfer twice ────────────────────────────────────────

const DUP_EVENT = `${TAG}_DUP`

test("a claim that looks like one already on file is held back until she says", async () => {
  await sql`
    INSERT INTO events (name, warehouse_id) SELECT ${DUP_EVENT}, id FROM warehouses ORDER BY id LIMIT 1`
  const [p] = await sql<{ id: number }[]>`SELECT id FROM products ORDER BY id LIMIT 1`
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_arrive)
    VALUES (${DUP_EVENT}, ${handle}, ${p.id}, 400000, 1, 1)`

  const first = await submitCustomerPayment({
    handle, event: DUP_EVENT, amount: 185000, bank: "BCA", sender: "Sari",
  })
  assert.ok(first.id)

  // Submitting again because the first seemed not to go through is the
  // ordinary way this happens, so she is told rather than refused.
  const held = await assert.rejects(
    () => submitCustomerPayment({
      handle, event: DUP_EVENT, amount: 185000, bank: "BCA", sender: "Sari",
    }),
    DuplicateClaimError,
  ).then(() => true)
  assert.ok(held)

  // What she is shown is the row itself, and it is hers, which is what lets
  // the sheet say "you told us about this" rather than "we have this".
  try {
    await submitCustomerPayment({
      handle, event: DUP_EVENT, amount: 185000, bank: "BCA", sender: "Sari",
    })
    assert.fail("should have been held")
  } catch (err) {
    assert.ok(err instanceof DuplicateClaimError)
    assert.equal(err.duplicate.amount, 185000)
    assert.equal(err.duplicate.reportedBy, "customer")
  }

  // And once she says it really was a second transfer, it goes through.
  const second = await submitCustomerPayment({
    handle, event: DUP_EVENT, amount: 185000, bank: "BCA", sender: "Sari",
    confirmDuplicate: true,
  })
  assert.ok(second.id !== first.id, "two transfers, two rows")

  // A different figure was never in question.
  const other = await submitCustomerPayment({
    handle, event: DUP_EVENT, amount: 60000, bank: "BCA", sender: "Sari",
  })
  assert.ok(other.id)
})

test("her own claims are marked as hers, so a warning can say so", async () => {
  const [row] = await sql<{ reported_by: string }[]>`
    SELECT reported_by FROM payments WHERE event = ${DUP_EVENT} ORDER BY id LIMIT 1`
  assert.equal(row.reported_by, "customer")
})
