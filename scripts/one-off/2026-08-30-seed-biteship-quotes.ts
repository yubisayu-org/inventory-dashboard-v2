/**
 * Write the quotes we already paid for into the table, without asking again.
 *
 * The 30 August audit quoted a one-kilo JNE parcel to every mapped area — 1.012
 * billable requests — and printed only the rows that disagreed. That is enough
 * to reconstruct all of it: a pair the audit did not name AGREED, which is what
 * "agrees to the rupiah" means, so its quote is the rate we already store.
 *
 * The 59 that disagreed are read from the run's own output, exactly as quoted.
 *
 * One honest gap: 5 pairs (13 customers) returned no quote at all in that run,
 * and nothing in the output separates them from the ones that agreed. They are
 * seeded as agreeing. A later `--refresh` on the audit corrects them, and costs
 * a request each.
 *
 *   npx tsx --env-file=.env.local scripts/one-off/2026-08-30-seed-biteship-quotes.ts
 *   npx tsx --env-file=.env.local scripts/one-off/2026-08-30-seed-biteship-quotes.ts --commit
 */

import { readFileSync } from "node:fs"
import sql from "@/lib/db-pool"

const COMMIT = process.argv.includes("--commit")
const OUTPUT = process.argv.find((a) => a.endsWith(".txt"))
  ?? "/private/tmp/claude-501/-Users-frhamadiansyah-Documents-Projects-Yubisayu-inventory-dashboard-v2/edee4c64-f39b-4e90-926b-145a3a246d76/scratchpad/audit2.txt"

// "   Cinere, Depok, Jawa Barat. 16514  (1c)  ours Rp 23.000  jne Rp 14.000  Rp -9.000   azeltrifiana"
const LINE = /^ {3}(.+?) {2}\((\d+)c\) {2}ours Rp ([\d.]+) {2}jne Rp ([\d.]+)/
const QUOTED_AT = "2026-08-30T00:00:00Z"

async function main() {
  const rupiah = (s: string) => Number(s.replace(/\./g, ""))
  const quoted = new Map<string, number>()
  for (const line of readFileSync(OUTPUT, "utf8").split("\n")) {
    const m = LINE.exec(line)
    if (m) quoted.set(`${m[1]}|${rupiah(m[3])}`, rupiah(m[4]))
  }
  console.log(`${quoted.size} disagreeing pairs read from the audit output.`)

  const pairs = (await sql`
    SELECT c.biteship_area_name AS area, cwo.ongkos_kirim::int AS ours, count(*)::int AS customers
      FROM customers c
      JOIN customer_warehouse_ongkir cwo
        ON cwo.customer_id = c.id AND cwo.warehouse_id = 1
     WHERE COALESCE(c.biteship_area_id, '') <> ''
     GROUP BY 1, 2
  `) as unknown as { area: string; ours: number; customers: number }[]

  let exact = 0, inferred = 0, exactCustomers = 0, inferredCustomers = 0
  const writes: { area: string; ours: number; price: number }[] = []
  for (const p of pairs) {
    const hit = quoted.get(`${p.area}|${p.ours}`)
    if (hit != null) { exact++; exactCustomers += p.customers }
    else { inferred++; inferredCustomers += p.customers }
    writes.push({ area: p.area, ours: p.ours, price: hit ?? p.ours })
  }
  console.log(
    `${exact} pairs written from the quote itself (${exactCustomers} customers), ` +
    `${inferred} from having agreed (${inferredCustomers} customers).`,
  )

  if (!COMMIT) {
    console.log("\nDRY RUN — nothing written. Re-run with --commit.")
    await sql.end()
    return
  }

  let rows = 0
  for (const w of writes) {
    const done = await sql`
      UPDATE customer_warehouse_ongkir cwo
         SET biteship_ongkir = ${w.price}, biteship_quoted_at = ${QUOTED_AT}
        FROM customers c
       WHERE c.id = cwo.customer_id
         AND cwo.warehouse_id = 1
         AND c.biteship_area_name = ${w.area}
         AND cwo.ongkos_kirim = ${w.ours}
      RETURNING cwo.customer_id
    `
    rows += done.length
  }
  console.log(`\nStored: ${rows} customer rows now carry a quote.`)
  await sql.end()
}

main().catch(async (err) => {
  console.error("Seed failed:", err)
  await sql.end()
  process.exit(1)
})
