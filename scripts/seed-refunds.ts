/**
 * A trip you can work from the beginning, on the local dev DB.
 *
 * No refunds are created. Every one you see, you make: mark an item sold out,
 * mark a parcel missing, broken or wrong, promote an overpayment from the To
 * check tab, or write a goodwill refund by hand. The point is to walk the whole
 * loop, not to look at its end state.
 *
 *   npx tsx --env-file-if-exists=.env.development.local scripts/seed-refunds.ts
 *   npx tsx --env-file-if-exists=.env.development.local scripts/seed-refunds.ts --clean
 *
 * Names are realistic on purpose — a seed you cannot tell from real data is the
 * only kind that shows you what the page will actually look like. That cuts
 * both ways, so this refuses to touch anything it did not create: it deletes
 * only the exact events, handles and products listed below, and refuses to seed
 * at all if one of them already exists. Local only.
 */
import sql from "@/lib/db-pool"
import { getPaymentStatus } from "@/lib/db"

const CLEAN = process.argv.includes("--clean")

/** The Japan trip everything happens on. */
const TRIP = "POCN202608"
/** A Korea trip, open and unpaid, for the outstanding-elsewhere prompt. */
const OTHER_TRIP = "LSKR202608"

type Person = {
  handle: string
  product: { name: string; store: string; gram: number }
  units: number
  /** Price per unit charged to the customer. */
  price: number
  /** Their shipping rate per kilo, from the warehouse. */
  ongkir: number
  /**
   * What they transferred, relative to their finished invoice. 0 pays it
   * exactly; a positive number overpays. Computed after the orders exist, so
   * ongkir and rounding are the real figures rather than arithmetic done here.
   */
  over?: number
  /** Nothing transferred at all. */
  unpaid?: boolean
  /**
   * Dispatched under this receipt and not yet arrived, which is what puts them
   * on the Arrival List. The prefix decides the route tab.
   */
  receipt?: string
  why: string
}

const PEOPLE: Person[] = [
  // ── Still to buy: mark sold out on the Shopping List ────────────────────
  // Three units, so marking one shows a partial refund rather than a line
  // vanishing whole — what actually happens, and the case most likely to be
  // got wrong.
  { handle: "nabila.tokyo", units: 3, price: 385_000, ongkir: 22_000,
    product: { name: "Muji Boston Bag 32L Navy", store: "MUJI", gram: 780 },
    why: "3 paid units, not yet bought — sold out → unavailable" },

  // ── In transit: mark on the Arrival List, one per mode ──────────────────
  { handle: "sarah.wijaya", units: 2, price: 690_000, ongkir: 25_000, receipt: "MNC-77201",
    product: { name: "Uniqlo Ultra Light Down Jacket", store: "UNIQLO", gram: 540 },
    why: "2 paid units at sea — missing → shipping_loss" },
  { handle: "dindaaa.p", units: 2, price: 245_000, ongkir: 18_000, receipt: "CJI-44508",
    product: { name: "Laneige Water Bank Cream Set", store: "LANEIGE", gram: 320 },
    why: "2 paid units by air — broken → damaged" },
  { handle: "okta.store", units: 1, price: 560_000, ongkir: 20_000, receipt: "HC-91330",
    product: { name: "Charles & Keith Shoulder Bag 9L", store: "CHARLES & KEITH", gram: 610 },
    why: "1 paid unit — wrong delivery → wrong_item" },
  // Dispatched and never paid. Marking this must create no refund: reducing an
  // unpaid order lowers what is owed, it does not owe anything back.
  { handle: "bella.mrt", units: 1, price: 148_000, ongkir: 15_000, receipt: "MU-19953", unpaid: true,
    product: { name: "Daiso Storage Box Clear M", store: "DAISO", gram: 260 },
    why: "dispatched, nothing paid — a mark must refund nothing" },

  // ── Overpaid, no mark behind it: these are the To check tab ─────────────
  { handle: "ratih.ayu", units: 1, price: 1_198_000, ongkir: 25_000, over: 42_000,
    product: { name: "Nintendo Switch 2 Joy-Con Pair", store: "BIC CAMERA", gram: 480 },
    why: "overpaid 42.000" },
  { handle: "melati.id", units: 1, price: 835_000, ongkir: 20_000, over: 15_000,
    product: { name: "Innisfree Green Tea Cleansing Foam", store: "INNISFREE", gram: 340 },
    why: "overpaid 15.000" },
  // Shipping-rounding noise: the rows that must not bury the ones above.
  { handle: "fitria.n", units: 1, price: 452_500, ongkir: 22_000, over: 2_500,
    product: { name: "Akachan Baby Wash 400ml", store: "AKACHAN", gram: 400 },
    why: "2.500 rounding" },
  { handle: "wulandari.s", units: 1, price: 310_000, ongkir: 18_000, over: 2_000,
    product: { name: "Nishimatsuya Bib Set 5pcs", store: "NISHIMATSUYA", gram: 210 },
    why: "2.000 rounding" },
  { handle: "intan.pv", units: 1, price: 196_200, ongkir: 15_000, over: 1_800,
    product: { name: "Daiso Silicone Spatula Set", store: "DAISO", gram: 80 },
    why: "1.800 rounding" },
  { handle: "gita.prm", units: 1, price: 275_000, ongkir: 20_000, over: 8_000,
    product: { name: "Muji Gel Ink Pen Set 10pcs", store: "MUJI", gram: 150 },
    why: "8.000 rounding" },
  { handle: "yulia.tan", units: 1, price: 150_000, ongkir: 15_000, over: 1_500,
    product: { name: "Daiso Bento Box 600ml", store: "DAISO", gram: 190 },
    why: "1.500 rounding" },

  // ── Paid to the rupiah: write a goodwill or other refund by hand ────────
  // No mark produces these two reasons, so they can only come from the New
  // refund button — which is the other half of the loop.
  { handle: "hesti.rk", units: 1, price: 355_000, ongkir: 22_000,
    product: { name: "Uniqlo Airism Bra Top", store: "UNIQLO", gram: 180 },
    why: "paid exactly — for a goodwill refund by hand" },
  { handle: "anjani.co", units: 1, price: 720_000, ongkir: 25_000,
    product: { name: "Muji Wall Shelf Oak 88cm", store: "MUJI", gram: 1_900 },
    why: "paid exactly — for an 'other' refund by hand" },

  // ── Owed here, behind on the Korea trip: the credit prompt ──────────────
  { handle: "laras.dwi", units: 1, price: 200_000, ongkir: 20_000, over: 60_000,
    product: { name: "Laneige Lip Sleeping Mask", store: "LANEIGE", gram: 120 },
    why: "overpaid 60.000 here, owes on " + OTHER_TRIP },
]

/** The one unpaid order on the other trip, which is what laras.dwi owes. */
const OTHER_ORDER = { handle: "laras.dwi", price: 300_000, gram: 610,
  product: { name: "Charles & Keith Quilted Crossbody", store: "CHARLES & KEITH", gram: 610 } }

const EVENTS = [TRIP, OTHER_TRIP]
const HANDLES = [...new Set(PEOPLE.map((p) => p.handle))]
const PRODUCTS = [...PEOPLE.map((p) => p.product.name), OTHER_ORDER.product.name]

async function clean() {
  await sql`DELETE FROM announcements WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id = ANY(${HANDLES}))`
  await sql`DELETE FROM payments  WHERE event = ANY(${EVENTS})`
  await sql`DELETE FROM refunds   WHERE event = ANY(${EVENTS})`
  await sql`DELETE FROM excess_purchase WHERE event = ANY(${EVENTS})`
  await sql`DELETE FROM orders    WHERE event = ANY(${EVENTS})`
  await sql`DELETE FROM events    WHERE name  = ANY(${EVENTS})`
  await sql`DELETE FROM customer_warehouse_ongkir WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id = ANY(${HANDLES}))`
  await sql`DELETE FROM customers WHERE instagram_id = ANY(${HANDLES})`
  // After the orders that referenced them.
  await sql`DELETE FROM products  WHERE name = ANY(${PRODUCTS})`
}

/**
 * Nothing here is tagged, so the only way to be sure a delete is safe is to
 * know we put the row there. Refuse the moment a name is already taken.
 */
async function assertNothingCollides() {
  const clashes: string[] = []
  for (const [label, rows] of [
    ["event", await sql`SELECT name AS n FROM events WHERE name = ANY(${EVENTS})`],
    ["customer", await sql`SELECT instagram_id AS n FROM customers WHERE instagram_id = ANY(${HANDLES})`],
    ["product", await sql`SELECT name AS n FROM products WHERE name = ANY(${PRODUCTS})`],
  ] as const) {
    for (const r of rows as unknown as { n: string }[]) clashes.push(`${label} "${r.n}"`)
  }
  if (clashes.length) {
    console.error("Refusing to seed — these already exist and are not ours to overwrite:")
    for (const c of clashes) console.error(`  ${c}`)
    console.error("\nRun with --clean first if this seed made them.")
    process.exit(1)
  }
}

async function main() {
  const url = process.env.DATABASE_URL ?? ""
  if (!/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) {
    console.error("Refusing to run: DATABASE_URL is not a local database.")
    process.exit(1)
  }

  if (CLEAN) {
    await clean()
    console.log("Removed every seeded row.")
    await sql.end()
    return
  }
  await assertNothingCollides()

  const [warehouse] = await sql<{ id: number }[]>`SELECT id FROM warehouses ORDER BY id LIMIT 1`
  if (!warehouse) throw new Error("No warehouse to seed against")

  for (const name of EVENTS) {
    await sql`INSERT INTO events (name, warehouse_id, eta) VALUES (${name}, ${warehouse.id}, 'ETA END SEPTEMBER')`
  }

  async function product(p: { name: string; store: string; gram: number }, price: number) {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO products (name, store, gram, price) VALUES (${p.name}, ${p.store}, ${p.gram}, ${price})
      RETURNING id`
    return row.id
  }

  for (const p of PEOPLE) {
    const [customer] = await sql<{ id: number }[]>`
      INSERT INTO customers (instagram_id) VALUES (${p.handle}) RETURNING id`
    await sql`
      INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim)
      VALUES (${customer.id}, ${warehouse.id}, ${p.ongkir})`
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit,
                          unit_buy, unit_dispatch, dispatch_receipt, dispatched_at)
      VALUES (${TRIP}, ${p.handle}, ${await product(p.product, p.price)}, ${p.price}, ${p.units},
              -- Dispatched stock was bought first, or the Shopping List would
              -- still offer to buy what is already in transit.
              ${p.receipt ? p.units : null},
              ${p.receipt ? p.units : null},
              ${p.receipt ?? ""},
              ${p.receipt ? sql`now()` : null})`
  }

  // The Korea trip: one order, never paid, so laras.dwi is outstanding there.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit, dispatch_receipt)
    VALUES (${OTHER_TRIP}, ${OTHER_ORDER.handle},
            ${await product(OTHER_ORDER.product, OTHER_ORDER.price)}, ${OTHER_ORDER.price}, 1, '')`

  // Payments last, and sized from the finished invoice rather than from the
  // order total: ongkir and its per-kilo rounding are part of what a customer
  // actually owes, and paying a figure computed here would leave everyone a few
  // thousand out.
  const invoices = new Map(
    (await getPaymentStatus()).filter((s) => s.event === TRIP).map((s) => [s.customer, s.invoiceTotal]),
  )
  for (const p of PEOPLE) {
    if (p.unpaid) continue
    const invoice = invoices.get(p.handle)
    if (invoice === undefined) throw new Error(`No invoice computed for ${p.handle}`)
    await sql`
      INSERT INTO payments (event, customer, amount, is_checked, kind)
      VALUES (${TRIP}, ${p.handle}, ${invoice + (p.over ?? 0)}, true, 'deposit')`
    console.log(`  ${p.handle.padEnd(16)} invoice ${String(invoice).padStart(9)}  ${p.why}`)
  }
  console.log(`  ${OTHER_ORDER.handle.padEnd(16)} ${"".padStart(9)}  unpaid order on ${OTHER_TRIP}`)

  console.log(`\nSeeded ${PEOPLE.length} customers on ${TRIP}, no refunds. Make them yourself.`)
  console.log("Remove with --clean.")
  await sql.end()
}

main().catch(async (err) => {
  console.error("Seed failed:", err)
  await sql.end()
  process.exit(1)
})
