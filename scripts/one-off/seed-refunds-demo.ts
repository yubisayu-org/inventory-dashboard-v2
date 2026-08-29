/**
 * One seed for the whole Refunds page.
 *
 * Six customers, real products at real prices and weights, on trips this
 * database actually has — so the invoices compute with ongkir the way a real
 * one does, and every figure on screen can be checked by hand.
 *
 * Replaces seed-pay-together.ts and seed-deposits.ts. Two seeds each cleaning
 * their own prefix was one command away from quietly deleting the other's data.
 *
 * Payments are written AFTER the orders and priced off `live_balances`, not
 * guessed: that is the same arithmetic the invoice uses, so "paid in full"
 * really is in full, ongkir and rounding included.
 *
 *   npx tsx --env-file=.env.development.local scripts/one-off/seed-refunds-demo.ts
 *   npx tsx --env-file=.env.development.local scripts/one-off/seed-refunds-demo.ts --clean
 */
import sql from "../../lib/db-pool"

const PREFIX = "demo_"
const RATE = 20_000 // per kg, hers on every warehouse

/** Trips this seed uses. Checked before anything is written. */
const NOW = "LSKR202608"      // the open trip
const RECENT = "LSJP202605"
const OLD_A = "LSKR202604"
const OLD_B = "LSCN202604"

type Line = { product: string; unit: number }
type Person = {
  handle: string
  what: string
  orders: { event: string; lines: Line[]; paid: "full" | "none" | number }[]
  refunds?: {
    event: string; reason: string; amount: number; status: string; note: string
    bank?: boolean
  }[]
}

const PEOPLE: Person[] = [
  {
    handle: `${PREFIX}rania`,
    what: "three things went wrong on one trip, all still Pending — the group sheet",
    orders: [{ event: NOW, lines: [
      { product: "Muji Boston Bag 38L Greige", unit: 2 },
      { product: "Muji Shoulder Bag 9L Beige", unit: 1 },
      { product: "Muji Gel Ink Pen 0.5 Black 10pcs", unit: 1 },
    ], paid: "full" }],
    refunds: [
      { event: NOW, reason: "unavailable", amount: 210000, status: "pending",
        note: "Muji Shoulder Bag 9L Beige × 1 × Rp 210.000" },
      { event: NOW, reason: "shipping_loss", amount: 770000, status: "pending",
        note: "Muji Boston Bag 38L Greige × 2 × Rp 385.000" },
      { event: NOW, reason: "damaged", amount: 105000, status: "pending",
        note: "Muji Gel Ink Pen 0.5 Black 10pcs × 1 × Rp 105.000" },
    ],
  },
  {
    handle: `${PREFIX}intan`,
    what: "overpaid AND owed for an item — the live figure, netted",
    // The production shape exactly: she paid for a trip that then lost an item,
    // so her invoice fell and she is Rp 495.000 up -- of which Rp 395.000 is
    // the goods refund below, and Rp 100.000 was a transfer typed wrong. If the
    // overpayment row shows the whole 495.000 the netting is broken.
    orders: [{ event: RECENT, lines: [
      { product: "Uniqlo Ultra Light Down Vest Navy", unit: 1 },
    ], paid: 495_000 }],
    refunds: [
      // Stored figure deliberately stale. It is READ from her balance, less
      // what the goods refund below already claims, so this row should display
      // Rp 100.000 whatever the 495.000 here says.
      { event: RECENT, reason: "overpayment", amount: 495000, status: "pending",
        note: "Auto-detected: paid more than the trip came to" },
      { event: RECENT, reason: "unavailable", amount: 395000, status: "ready_to_refund",
        note: "Uniqlo Ultra Light Down Vest Navy × 1 × Rp 395.000", bank: true },
    ],
  },
  {
    handle: `${PREFIX}sekar`,
    what: "holding deposits from three trips, and owes on a fourth — Deposits, the banner, apply as credit",
    orders: [
      { event: NOW, lines: [{ product: "Muji Acrylic Drawer 3 Tier", unit: 1 }], paid: "none" },
      { event: RECENT, lines: [{ product: "Uniqlo Airism Tee Men L White", unit: 1 }], paid: "full" },
    ],
    refunds: [
      { event: RECENT, reason: "overpayment", amount: 170000, status: "applied_to_next_order",
        note: "She asked to keep it for the next trip" },
      { event: OLD_A, reason: "unavailable", amount: 210000, status: "applied_to_next_order",
        note: "Muji Shoulder Bag 9L Beige × 1 × Rp 210.000" },
      { event: OLD_B, reason: "damaged", amount: 105000, status: "applied_to_next_order",
        note: "Muji Gel Ink Pen 0.5 Black 10pcs × 1 × Rp 105.000" },
    ],
  },
  {
    handle: `${PREFIX}wulan`,
    what: "one deposit and nothing owed anywhere — the plain row, and the credit dead end",
    orders: [{ event: OLD_A, lines: [{ product: "Uniqlo Kids Legging 110 Grey", unit: 1 }], paid: "full" }],
    refunds: [
      { event: OLD_A, reason: "quality", amount: 60000, status: "applied_to_next_order",
        note: "Uniqlo Kids Legging 110 Grey × 1 × Rp 120.000 — half back, she kept it" },
    ],
  },
  {
    handle: `${PREFIX}ayu`,
    what: "paid more than the trip came to, and nobody has filed anything — To check",
    orders: [{ event: NOW, lines: [{ product: "Muji Boston Bag 38L Black", unit: 1 }], paid: "full" }],
  },
  {
    handle: `${PREFIX}dara`,
    what: "asked for her bank details, still waiting — Bank Info, and lines to build a Quality refund from",
    orders: [{ event: NOW, lines: [
      { product: "Uniqlo Airism Tee Men L White", unit: 3 },
      { product: "Muji Gel Ink Pen 0.5 Black 10pcs", unit: 2 },
    ], paid: "full" }],
    refunds: [
      { event: NOW, reason: "damaged", amount: 170000, status: "awaiting_bank_info",
        note: "Uniqlo Airism Tee Men L White × 1 × Rp 170.000" },
    ],
  },
]

/** Paid more than the invoice, by this much, with no refund covering it. */
const AYU_SURPLUS = 137_000

async function clean() {
  // The two seeds this replaces, so an old prefix cannot linger and confuse
  // what is on screen.
  for (const p of [PREFIX, "zztest_", "zzdep_"]) {
    await sql`DELETE FROM announcements WHERE customer_id IN (
      SELECT id FROM customers WHERE instagram_id LIKE ${`${p}%`})`
    await sql`DELETE FROM payments WHERE customer LIKE ${`${p}%`}`
    await sql`DELETE FROM refunds WHERE customer LIKE ${`${p}%`}`
    await sql`DELETE FROM adjustments WHERE customer LIKE ${`${p}%`}`
    await sql`DELETE FROM orders WHERE customer LIKE ${`${p}%`}`
    await sql`DELETE FROM customer_shipping_prefs WHERE customer_id IN (
      SELECT id FROM customers WHERE instagram_id LIKE ${`${p}%`})`
    await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id IN (
      SELECT id FROM customers WHERE instagram_id LIKE ${`${p}%`})`
    await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${p}%`}`
  }
}

async function main() {
  if (process.argv.includes("--clean")) {
    await clean()
    console.log("Removed every demo_ row (and the old zztest_ / zzdep_ seeds).")
    return
  }

  await clean()

  const events = [NOW, RECENT, OLD_A, OLD_B]
  const haveEvents = (await sql<{ name: string }[]>`
    SELECT name FROM events WHERE name = ANY(${events})`).map((r) => r.name)
  const missingEvents = events.filter((e) => !haveEvents.includes(e))
  if (missingEvents.length) {
    throw new Error(`This database has no ${missingEvents.join(", ")} — edit the trip constants`)
  }

  const wantedProducts = [...new Set(PEOPLE.flatMap((p) => p.orders.flatMap((o) => o.lines.map((l) => l.product))))]
  const products = new Map(
    (await sql<{ id: number; name: string; price: number }[]>`
      SELECT id, name, COALESCE(price, 0)::int AS price FROM products WHERE name = ANY(${wantedProducts})`)
      .map((r) => [r.name, r]),
  )
  const missingProducts = wantedProducts.filter((n) => !products.has(n))
  if (missingProducts.length) {
    throw new Error(`This database has no ${missingProducts.join(", ")} — edit the product names`)
  }

  for (const person of PEOPLE) {
    await sql`INSERT INTO customers (instagram_id, whatsapp) VALUES (${person.handle}, '628123456789')`
    // Her ongkir, on every warehouse, so each trip prices the same way.
    await sql`
      INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
      SELECT c.id, w.id, ${RATE} FROM customers c CROSS JOIN warehouses w
       WHERE c.instagram_id = ${person.handle}`

    for (const order of person.orders) {
      for (const line of order.lines) {
        const p = products.get(line.product)!
        await sql`
          INSERT INTO orders (event, customer, product_id, unit_price, unit, unit_buy)
          VALUES (${order.event}, ${person.handle}, ${p.id}, ${p.price}, ${line.unit}, ${line.unit})`
      }
    }
  }

  // Now the orders exist, price the payments off the same arithmetic the
  // invoice uses — subtotal plus ongkir per rounded kilo — rather than guessing
  // at a total and having "paid in full" be nearly.
  for (const person of PEOPLE) {
    for (const order of person.orders) {
      if (order.paid === "none") continue
      const [bal] = await sql<{ invoice_total: number }[]>`
        SELECT invoice_total FROM live_balances
         WHERE event = ${order.event} AND customer = ${person.handle}`
      const invoice = Number(bal?.invoice_total ?? 0)
      const amount = order.paid === "full" ? invoice : invoice + order.paid
      if (amount <= 0) continue
      await sql`
        INSERT INTO payments (event, customer, amount, account, is_checked, kind, remarks)
        VALUES (${order.event}, ${person.handle}, ${amount}, 'BCA', true, 'deposit', 'seed')`
    }
  }

  // ayu's surplus, on top of a settled invoice, with nothing filed against it.
  await sql`
    INSERT INTO payments (event, customer, amount, account, is_checked, kind, remarks)
    VALUES (${NOW}, ${`${PREFIX}ayu`}, ${AYU_SURPLUS}, 'BCA', true, 'deposit', 'seed: transferred twice by mistake')`

  for (const person of PEOPLE) {
    for (const r of person.refunds ?? []) {
      await sql`
        INSERT INTO refunds (event, customer, reason, refund_amount, status,
                             bank_name, bank_account_number, bank_account_holder, note)
        VALUES (${r.event}, ${person.handle}, ${r.reason}, ${r.amount}, ${r.status},
                ${r.bank ? "BCA" : ""}, ${r.bank ? "8720114455" : ""},
                ${r.bank ? person.handle.replace(PREFIX, "").toUpperCase() : ""}, ${r.note})`
    }
  }

  const summary = await sql<{ cust: string; status: string; n: string; total: string }[]>`
    SELECT customer AS cust, status, count(*) AS n, SUM(refund_amount)::int AS total
      FROM refunds WHERE customer LIKE ${`${PREFIX}%`}
     GROUP BY customer, status ORDER BY customer, status`

  console.log(`Seeded ${PEOPLE.length} customers on ${NOW} / ${RECENT} / ${OLD_A} / ${OLD_B}.\n`)
  for (const person of PEOPLE) {
    console.log(`  ${person.handle.padEnd(14)} ${person.what}`)
    for (const row of summary.filter((r) => r.cust === person.handle)) {
      console.log(`  ${"".padEnd(14)}   ${row.n} × ${row.status} · Rp ${Number(row.total).toLocaleString("id-ID")}`)
    }
  }
  console.log(`
  What to try, tab by tab:

  To check      ${PREFIX}ayu paid Rp ${AYU_SURPLUS.toLocaleString("id-ID")} too much and nothing is filed.
                Press the open-invoice arrow to land on her trip, then promote it.
  Pending       ${PREFIX}rania has three on ${NOW} — one row, "3 refunds". Open it for the
                group sheet: her account saved to all three, one message, one transfer.
                She has no bank details, so it refuses to send until you type one.
  Bank Info     ${PREFIX}dara, waiting on her account. Her order also has priced lines,
                so New Refund → Quality can pick items off it.
  Transfer      ${PREFIX}intan's Rp 395.000, ready to send.
  Live amount   ${PREFIX}intan is Rp 495.000 up and her row SAYS Rp 495.000 --
                it should DISPLAY Rp 100.000, because the goods refund above
                already claims Rp 395.000 of that balance. Pay them together and
                she gets 495.000 once, not 890.000.
  Deposits      ${PREFIX}sekar holds three, from three trips, in one row.
                ${PREFIX}wulan holds one — a plain row, no caret.
  Banner        ${PREFIX}sekar owes on ${NOW} and holds Rp 485.000. Her invoice should
                offer it, and "Use all" should stop once the bill is covered.
  Credit        Open one of ${PREFIX}sekar's deposits → Apply as credit → only ${NOW}
                is offered, because it is the only trip of hers that owes anything.
                ${PREFIX}wulan's has no target at all, and says so.
  Keep it       Any Pending row → Keep on her account. It moves to Deposits.

  Undo with:  npx tsx --env-file=.env.development.local scripts/one-off/seed-refunds-demo.ts --clean`)
}

main().then(() => sql.end()).catch(async (err) => {
  console.error(err)
  await sql.end()
  process.exit(1)
})
