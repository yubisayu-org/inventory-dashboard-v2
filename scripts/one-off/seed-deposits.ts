/**
 * Seed the Refunds → Deposits tab.
 *
 * A deposit is money she asked to keep rather than take back: status
 * `applied_to_next_order`, the amount still on the row, no payment written.
 * The tab groups them by CUSTOMER rather than by trip, because what matters is
 * how much of her money the shop is holding — so the seed gives three shapes:
 * somebody holding money from several trips, somebody from two, and somebody
 * with a single one (who should render as a plain row with no caret at all).
 *
 * Uses its own `zzdep_` prefix so it cannot be wiped by the pay-together seed,
 * which cleans every `zztest_` row.
 *
 *   npx tsx --env-file=.env.development.local scripts/one-off/seed-deposits.ts
 *   npx tsx --env-file=.env.development.local scripts/one-off/seed-deposits.ts --clean
 */
import sql from "../../lib/db-pool"

const PREFIX = "zzdep_"

/** Handle → the deposits she is holding, oldest trip first. */
const PEOPLE: Record<string, { event: string; reason: string; amount: number; note: string }[]> = {
  [`${PREFIX}tigatrip`]: [
    { event: "LSJP202603", reason: "overpayment", amount: 482000,
      note: "seed: transferred more than the trip came to" },
    { event: "LSCN202604", reason: "unavailable", amount: 160000,
      note: "Muji Bucket Hat with String × 1 × Rp 160.000" },
    { event: "LSKR202604", reason: "damaged", amount: 95000,
      note: "Muji Shoulder Bag 9L Beige × 1 × Rp 95.000" },
  ],
  [`${PREFIX}duatrip`]: [
    { event: "LSJP202605", reason: "shipping_loss", amount: 200000,
      note: "Muji Boston Bag 38L Greige × 2 × Rp 100.000" },
    { event: "POCN202608", reason: "overpayment", amount: 18000,
      note: "seed: rounding on the last payment" },
  ],
  [`${PREFIX}satutrip`]: [
    { event: "LSKR202608", reason: "quality", amount: 45000,
      note: "Muji Aroma Diffuser Small × 1 × Rp 45.000" },
  ],
  // Deliberately NOT a deposit: she is owed this in cash, and it belongs on
  // Pending. If it shows up under Deposits the tab filter is wrong.
  [`${PREFIX}bukandeposit`]: [],
}

async function clean() {
  await sql`DELETE FROM announcements WHERE customer_id IN (
    SELECT id FROM customers WHERE instagram_id LIKE ${`${PREFIX}%`})`
  await sql`DELETE FROM payments WHERE customer LIKE ${`${PREFIX}%`}`
  await sql`DELETE FROM refunds WHERE customer LIKE ${`${PREFIX}%`}`
  await sql`DELETE FROM customers WHERE instagram_id LIKE ${`${PREFIX}%`}`
}

async function main() {
  if (process.argv.includes("--clean")) {
    await clean()
    console.log("Removed every zzdep_ row.")
    return
  }

  await clean()

  const wanted = [...new Set(Object.values(PEOPLE).flat().map((d) => d.event))]
  const found = (await sql<{ name: string }[]>`
    SELECT name FROM events WHERE name = ANY(${wanted})`).map((r) => r.name)
  const missing = wanted.filter((e) => !found.includes(e))
  if (missing.length) {
    throw new Error(`This database has no ${missing.join(", ")} — edit PEOPLE to trips it does have`)
  }

  for (const [who, deposits] of Object.entries(PEOPLE)) {
    await sql`INSERT INTO customers (instagram_id, whatsapp) VALUES (${who}, '628123456789')`
    for (const d of deposits) {
      // Bank details cleared, as keeping it on account does: they were collected
      // to send money to, and nothing is being sent.
      await sql`
        INSERT INTO refunds (event, customer, reason, refund_amount, status,
                             bank_name, bank_account_number, bank_account_holder, note)
        VALUES (${d.event}, ${who}, ${d.reason}, ${d.amount}, 'applied_to_next_order',
                '', '', '', ${d.note})`
    }
  }

  // The control: money owed in cash, on the Pending tab, not here.
  await sql`
    INSERT INTO refunds (event, customer, reason, refund_amount, status, note)
    VALUES ('LSKR202608', ${`${PREFIX}bukandeposit`}, 'unavailable', 120000, 'pending',
            'seed: owed in cash — should NOT appear under Deposits')`

  const rows = await sql<{ cust: string; n: string; total: string }[]>`
    SELECT customer AS cust, count(*) AS n, SUM(refund_amount)::int AS total
      FROM refunds
     WHERE customer LIKE ${`${PREFIX}%`} AND status = 'applied_to_next_order'
     GROUP BY customer ORDER BY SUM(refund_amount) DESC`

  console.log(`Seeded the Deposits tab.\n`)
  for (const r of rows) {
    console.log(`  ${r.cust.padEnd(22)} ${String(r.n).padStart(2)} deposit(s)  Rp ${Number(r.total).toLocaleString("id-ID")}`)
  }
  console.log(`
  Refunds → Deposits. Expect:
    ${PREFIX}tigatrip     one row, "3 trips", Rp 737.000 — open it for the three
    ${PREFIX}duatrip      one row, "2 trips", Rp 218.000
    ${PREFIX}satutrip     a plain row, no caret — one deposit is not a group
    ${PREFIX}bukandeposit NOT here. It is on Pending, owed in cash.

  No "Pay all" anywhere on this tab, and a group row opens nothing: none of it
  is going to a bank.

  Undo with:  npx tsx --env-file=.env.development.local scripts/one-off/seed-deposits.ts --clean`)
}

main().then(() => sql.end()).catch(async (err) => {
  console.error(err)
  await sql.end()
  process.exit(1)
})
