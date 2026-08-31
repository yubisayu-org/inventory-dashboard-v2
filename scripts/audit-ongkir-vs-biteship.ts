/**
 * What we charge for shipping, against what the courier would charge.
 *
 * The invoice's shipping line is `customer_warehouse_ongkir.ongkos_kirim ×
 * the parcel's kilos` — a per-kilo rate set once per customer, most of them
 * carried over from the old JNE table. This asks JNE what a one-kilo parcel
 * to each mapped area actually costs today and prints the two side by side.
 *
 * The quotes are kept: `biteship_ongkir` beside `ongkos_kirim`, in its own
 * column, never overwriting ours. Every request is billed, so a second run
 * reads what the first one paid for and asks only about areas nobody has
 * quoted yet. `--refresh` asks about everything again, on purpose.
 *
 * It changes no PRICE and is not meant to: a rate that disagrees
 * may be a discount somebody granted on purpose, and only a person knows
 * which. One request per distinct AREA, not per customer — a thousand areas
 * across three thousand customers costs a thousand requests.
 *
 *   npx tsx --env-file=.env.local scripts/audit-ongkir-vs-biteship.ts
 *   npx tsx --env-file=.env.local scripts/audit-ongkir-vs-biteship.ts --warehouse DEPOK
 *   npx tsx --env-file=.env.local scripts/audit-ongkir-vs-biteship.ts --refresh
 */

import sql from "@/lib/db-pool"
import { courierRates, BiteshipNotConfiguredError } from "@/lib/biteship"

const argv = process.argv.slice(2)
const warehouseCode = (argv[argv.indexOf("--warehouse") + 1] ?? "CIMAHI").toUpperCase()
/**
 * Ask the courier again even where a quote is already stored.
 *
 * Off by default, because every request is billed and place-to-place rates
 * move about once a year. The stored quote is read instead, and only areas
 * that have never been quoted cost anything.
 */
const REFRESH = argv.includes("--refresh")

const rupiah = (n: number) => `Rp ${new Intl.NumberFormat("id-ID").format(n)}`

async function main() {
  const [origin] = (await sql`
    SELECT id, code, biteship_area_id AS area FROM warehouses WHERE code = ${warehouseCode}
  `) as unknown as { id: number; code: string; area: string | null }[]
  if (!origin?.area) {
    console.error(`Warehouse ${warehouseCode} has no Biteship origin set — nothing to quote from.`)
    await sql.end()
    process.exit(1)
  }

  // Grouped by area AND rate: two customers in one area on different rates are
  // two rows, because that is itself a thing worth seeing.
  const rows = (await sql`
    SELECT c.biteship_area_id AS area_id, c.biteship_area_name AS area_name,
           cwo.ongkos_kirim::int AS ours,
           count(*)::int AS customers,
           string_agg(lower(replace(c.instagram_id, '@', '')), ', ' ORDER BY c.instagram_id) AS handles
      FROM customers c
      JOIN customer_warehouse_ongkir cwo
        ON cwo.customer_id = c.id AND cwo.warehouse_id = ${origin.id}
     WHERE COALESCE(c.biteship_area_id, '') <> ''
     GROUP BY 1, 2, 3
     ORDER BY count(*) DESC
  `) as unknown as {
    area_id: string; area_name: string; ours: number; customers: number; handles: string
  }[]

  const areas = new Set(rows.map((r) => r.area_id))
  console.log(`${rows.length} area/rate pairs over ${areas.size} areas, from ${origin.code}.`)
  console.log(`Quoting a one-kilo JNE parcel for each area.\n`)

  // What was already paid for. A quote belongs to an area, so one stored row
  // answers for every customer in it.
  const known = new Map<string, number>()
  if (!REFRESH) {
    const rows = (await sql`
      SELECT c.biteship_area_id AS area_id, max(cwo.biteship_ongkir)::int AS price
        FROM customers c
        JOIN customer_warehouse_ongkir cwo
          ON cwo.customer_id = c.id AND cwo.warehouse_id = ${origin.id}
       WHERE COALESCE(c.biteship_area_id, '') <> '' AND cwo.biteship_ongkir IS NOT NULL
       GROUP BY 1
    `) as unknown as { area_id: string; price: number }[]
    for (const r of rows) known.set(r.area_id, r.price)
    console.log(`${known.size} areas answered from stored quotes — no request, no charge.`)
  }

  const quotes = new Map<string, number | null>()
  let done = 0
  let asked = 0
  for (const areaId of areas) {
    if (++done % 100 === 0 || done === areas.size) console.log(`   … ${done}/${areas.size}`)
    const stored = known.get(areaId)
    if (stored != null) { quotes.set(areaId, stored); continue }
    asked++
    try {
      const rates = await courierRates(origin.area, areaId, 1000)
      const reg = rates.find((r) => /^(reg|ctc)$/i.test(r.serviceCode)) ?? rates[0]
      quotes.set(areaId, reg ? reg.price : null)
    } catch (err) {
      if (err instanceof BiteshipNotConfiguredError) {
        console.error("BITESHIP_API_KEY is not set.")
        await sql.end()
        process.exit(1)
      }
      quotes.set(areaId, null)
    }
  }

  if (asked > 0) console.log(`${asked} areas had to be asked for — storing them, so the next run is free.`)

  // Store the answer on every customer of the area that lacks one.
  //
  // Not only the areas we just paid for: a customer mapped into an area a
  // NEIGHBOUR had already quoted costs nothing to fill, and skipping her
  // leaves a NULL that the pricing switch would read as "no quote" and fall
  // back to the very rate the quote was meant to replace. `IS NULL` keeps a
  // stored quote authoritative unless --refresh asked for a new one.
  let stored = 0
  for (const [areaId, price] of quotes) {
    if (price == null) continue
    const rows = await sql`
      UPDATE customer_warehouse_ongkir cwo
         SET biteship_ongkir = ${price}, biteship_quoted_at = NOW()
        FROM customers c
       WHERE c.id = cwo.customer_id
         AND cwo.warehouse_id = ${origin.id}
         AND c.biteship_area_id = ${areaId}
         AND (cwo.biteship_ongkir IS NULL OR (${REFRESH} AND cwo.biteship_ongkir <> ${price}))
      RETURNING cwo.customer_id
    `
    stored += rows.length
  }
  if (stored) console.log(`${stored} customer rows given a quote.`)

  const over: typeof rows & { diff?: number }[] = []
  const under: typeof rows & { diff?: number }[] = []
  let same = 0, sameCust = 0, unquoted = 0, unquotedCust = 0
  const detail: { r: (typeof rows)[number]; quote: number; diff: number }[] = []
  for (const r of rows) {
    const quote = quotes.get(r.area_id)
    if (quote == null) { unquoted++; unquotedCust += r.customers; continue }
    const diff = quote - r.ours
    if (diff === 0) { same++; sameCust += r.customers; continue }
    detail.push({ r, quote, diff })
  }

  const overCharged = detail.filter((d) => d.diff < 0)
  const underCharged = detail.filter((d) => d.diff > 0)
  console.log(`\n${same} pairs agree to the rupiah (${sameCust} customers).`)
  console.log(`${unquoted} could not be quoted (${unquotedCust} customers).`)
  console.log(
    `${overCharged.length} pairs where we charge MORE than JNE quotes ` +
    `(${overCharged.reduce((n, d) => n + d.r.customers, 0)} customers).`,
  )
  console.log(
    `${underCharged.length} pairs where we charge LESS — the shop pays the difference ` +
    `(${underCharged.reduce((n, d) => n + d.r.customers, 0)} customers).\n`,
  )

  const show = (title: string, list: typeof detail) => {
    if (!list.length) return
    console.log(`\n${title}`)
    for (const d of [...list].sort((a, b) => Math.abs(b.diff) * b.r.customers - Math.abs(a.diff) * a.r.customers)) {
      console.log(
        `   ${d.r.area_name}  (${d.r.customers}c)  ours ${rupiah(d.r.ours)}  jne ${rupiah(d.quote)}` +
        `  ${d.diff > 0 ? "+" : ""}${rupiah(d.diff)}   ${d.r.handles}`,
      )
    }
  }
  show("We charge LESS than JNE quotes — the shop absorbs it:", underCharged)
  show("We charge MORE than JNE quotes:", overCharged)

  await sql.end()
}

main().catch(async (err) => {
  console.error("Audit failed:", err)
  await sql.end()
  process.exit(1)
})
