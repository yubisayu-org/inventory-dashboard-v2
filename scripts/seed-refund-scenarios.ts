/**
 * Realistic refunds to click through on the local dev DB.
 *
 * Every case the Refunds page can show, so each tab and each button has
 * something real behind it: an uncovered overpayment, one a mark has partly
 * covered, one fully covered (which must NOT appear), a handful of small
 * roundings that should collapse, and a refund sitting in every status.
 *
 *   npx tsx --env-file-if-exists=.env.development.local scripts/seed-refund-scenarios.ts
 *   npx tsx --env-file-if-exists=.env.development.local scripts/seed-refund-scenarios.ts --clean
 *
 * Everything is tagged SEEDRF so --clean removes exactly what this made and
 * nothing else. Local only — it refuses to run against a remote database.
 */
import sql from "@/lib/db-pool"

// Lower case on purpose: handles are canonically bare and lower case in this
// system (migration 021), and refunds.customer is a foreign key onto
// customers.instagram_id while createRefund normalizes what it is given. A
// seeded capital would break that join in a way real data never does.
const TAG = "seedrf"
const CLEAN = process.argv.includes("--clean")

const EVENT_A = `${TAG}-TRIP-A`
const EVENT_B = `${TAG}-TRIP-B`

type Person = {
  handle: string
  /** Units on the order. One unless a partial mark is the point. */
  units?: number
  /** Its own product, so a mark on it does not touch everyone else. */
  ownProduct?: boolean
  /** What they ordered, in rupiah. */
  ordered: number
  /** What they transferred. */
  paid: number
  /** Refunds already on the books for them. */
  refunds?: { reason: string; amount: number; status: string; note?: string }[]
  event?: string
  why: string
}

const PEOPLE: Person[] = [
  // ── To check: uncovered, listed individually ────────────────────────────
  { handle: `${TAG}_nadya`,  ordered: 1_198_000, paid: 1_240_000, why: "overpaid 42.000, nothing refunded" },
  { handle: `${TAG}_qkooy`,  ordered:   300_000, paid:   550_000, why: "owed 250.000, a mark covered 200.000",
    refunds: [{ reason: "unavailable", amount: 200_000, status: "pending", note: "Muji Boston Bag 38L · sold out" }] },
  { handle: `${TAG}_rina`,   ordered:   855_000, paid:   870_000, why: "overpaid 15.000, nothing refunded" },

  // ── Fully covered: must NOT appear in To check ──────────────────────────
  { handle: `${TAG}_sari`,   ordered:   400_000, paid:   430_000, why: "overpaid 30.000, already refunded in full",
    refunds: [{ reason: "overpayment", amount: 30_000, status: "pending" }] },

  // ── To check: small, should collapse behind one line ────────────────────
  { handle: `${TAG}_melia`,  ordered:   452_500, paid:   455_000, why: "2.500 rounding" },
  { handle: `${TAG}_dwi`,    ordered:   310_000, paid:   312_000, why: "2.000 rounding" },
  { handle: `${TAG}_yuni`,   ordered:   196_200, paid:   198_000, why: "1.800 rounding" },
  { handle: `${TAG}_indah`,  ordered:   275_000, paid:   283_000, why: "8.000 rounding" },
  { handle: `${TAG}_putri`,  ordered:   150_000, paid:   151_500, why: "1.500 rounding" },

  // ── A pending refund for every reason the picker offers ─────────────────
  // Six presets plus the free-text one that has crept in, each with the note a
  // real one would carry, so the Pending tab shows what every reason looks like.
  { handle: `${TAG}_lisa`,   ordered:   640_000, paid:   640_000, why: "pending · unavailable",
    refunds: [{ reason: "unavailable", amount: 180_000, status: "pending", note: "Muji Boston Bag 38L Greige · 1 unit · sold out at the store" }] },
  { handle: `${TAG}_tika`,   ordered:   925_000, paid:   925_000, why: "pending · shipping_loss",
    refunds: [{ reason: "shipping_loss", amount: 310_000, status: "pending", note: "MNC-29786 · 2 units never arrived" }] },
  { handle: `${TAG}_fitri`,  ordered:   480_000, paid:   480_000, why: "pending · damaged",
    refunds: [{ reason: "damaged", amount: 95_000, status: "pending", note: "arrived with a torn seam" }] },
  { handle: `${TAG}_wulan`,  ordered:   355_000, paid:   355_000, why: "pending · goodwill",
    refunds: [{ reason: "goodwill", amount: 25_000, status: "pending", note: "late by three weeks, offered a discount" }] },
  { handle: `${TAG}_ayu`,    ordered:   720_000, paid:   720_000, why: "pending · other",
    refunds: [{ reason: "other", amount: 40_000, status: "pending", note: "ongkir charged twice on the same parcel" }] },
  { handle: `${TAG}_maya`,   ordered:   210_000, paid:   210_000, why: "pending · wrong item (free-text reason)",
    refunds: [{ reason: "Wrong item", amount: 210_000, status: "pending", note: "sent Shoulder Bag 9L, ordered Boston Bag 38L" }] },

  // ── One refund in every status, so every tab has rows ───────────────────
  { handle: `${TAG}_bank`,   ordered:   500_000, paid:   500_000, why: "refund awaiting bank info",
    refunds: [{ reason: "damaged", amount: 75_000, status: "awaiting_bank_info", note: "arrived dented" }] },
  { handle: `${TAG}_ready`,  ordered:   500_000, paid:   500_000, why: "refund ready to transfer",
    refunds: [{ reason: "shipping_loss", amount: 120_000, status: "ready_to_refund", note: "lost in transit" }] },
  { handle: `${TAG}_done`,   ordered:   500_000, paid:   500_000, why: "refund already sent",
    refunds: [{ reason: "unavailable", amount: 60_000, status: "refunded", note: "sold out" }] },
  { handle: `${TAG}_credit`, ordered:   500_000, paid:   500_000, why: "refund applied as credit",
    refunds: [{ reason: "overpayment", amount: 45_000, status: "applied_to_next_order" }] },
  { handle: `${TAG}_void`,   ordered:   500_000, paid:   500_000, why: "refund cancelled",
    refunds: [{ reason: "other", amount: 20_000, status: "cancelled", note: "raised by mistake" }] },

  // ── To mark by hand, and watch a refund appear ──────────────────────────
  // Three paid units, so marking one sold out shows a PARTIAL refund rather
  // than a line vanishing whole — which is what actually happens, and the case
  // most likely to be got wrong.
  { handle: `${TAG}_markme`, ordered: 100_000, units: 3, paid: 300_000, ownProduct: true,
    why: "3 paid units on their own product — mark sold out to see a refund" },

  // ── Owes on another trip, and is owed on this one (for the credit prompt) ─
  { handle: `${TAG}_owing`,  ordered:   200_000, paid:   260_000, why: "owed 60.000 here, owes 300.000 on trip B" },
]

async function clean() {
  // ILIKE, not LIKE: an earlier run seeded these handles in capitals, and a
  // case-sensitive delete would leave them behind to collide with the
  // lower-case ones on the unique index.
  await sql`DELETE FROM announcements WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id ILIKE ${`${TAG}%`})`
  await sql`DELETE FROM payments  WHERE event ILIKE ${`${TAG}%`}`
  await sql`DELETE FROM refunds   WHERE event ILIKE ${`${TAG}%`}`
  await sql`DELETE FROM excess_purchase WHERE event ILIKE ${`${TAG}%`}`
  await sql`DELETE FROM orders    WHERE event ILIKE ${`${TAG}%`}`
  await sql`DELETE FROM events    WHERE name  ILIKE ${`${TAG}%`}`
  await sql`DELETE FROM customers WHERE instagram_id ILIKE ${`${TAG}%`}`
  console.log("Removed every seeded row.")
}

async function main() {
  const url = process.env.DATABASE_URL ?? ""
  if (!/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) {
    console.error("Refusing to run: DATABASE_URL is not a local database.")
    process.exit(1)
  }

  await clean()
  if (CLEAN) { await sql.end(); return }

  // A zero-gram product keeps the invoice arithmetic exactly the order total —
  // no ongkir term to reason about while clicking around.
  const products = await sql<{ id: number }[]>`
    SELECT id FROM products WHERE COALESCE(gram, 0) = 0 ORDER BY id LIMIT 2`
  if (products.length === 0) throw new Error("No zero-gram product to seed against")
  const product = products[0]
  // A second product for anyone who is going to be marked, so the mark does not
  // reduce every other seeded order for the same item.
  const soloProduct = products[1] ?? products[0]

  for (const name of [EVENT_A, EVENT_B]) {
    await sql`INSERT INTO events (name, warehouse_id) SELECT ${name}, id FROM warehouses ORDER BY id LIMIT 1`
  }

  for (const p of PEOPLE) {
    const event = p.event ?? EVENT_A
    await sql`INSERT INTO customers (instagram_id) VALUES (${p.handle}) ON CONFLICT DO NOTHING`
    await sql`
      INSERT INTO orders (event, customer, product_id, unit_price, unit)
      VALUES (${event}, ${p.handle}, ${p.ownProduct ? soloProduct.id : product.id}, ${p.ordered}, ${p.units ?? 1})`
    if (p.paid > 0) {
      await sql`
        INSERT INTO payments (event, customer, amount, is_checked, kind)
        VALUES (${event}, ${p.handle}, ${p.paid}, true, 'deposit')`
    }
    for (const r of p.refunds ?? []) {
      await sql`
        INSERT INTO refunds (event, customer, reason, refund_amount, status, note)
        VALUES (${event}, ${p.handle}, ${r.reason}, ${r.amount}, ${r.status}, ${r.note ?? ""})`
    }
    console.log(`  ${p.handle.padEnd(18)} ${p.why}`)
  }

  // The one who owes elsewhere: an unpaid order on trip B.
  await sql`
    INSERT INTO orders (event, customer, product_id, unit_price, unit)
    VALUES (${EVENT_B}, ${`${TAG}_owing`}, ${product.id}, 300000, 1)`

  console.log(`\nSeeded ${PEOPLE.length} customers across ${EVENT_A} and ${EVENT_B}.`)
  console.log("Remove with --clean.")
  await sql.end()
}

main().catch(async (err) => {
  console.error("Seed failed:", err)
  await sql.end()
  process.exit(1)
})
