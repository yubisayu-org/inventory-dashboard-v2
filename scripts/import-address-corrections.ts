/**
 * Read the corrected spreadsheet back in, one customer at a time.
 *
 * Only three columns are read: kota, kecamatan, kode_pos. Everything else in
 * the file is there for the person deciding and is ignored here, so a stale
 * price column cannot write anything.
 *
 * Every corrected address is put through the same resolution the backfill uses
 * -- search the district, fall back to the postal code, tolerate the spelling
 * and the numerals -- and the area is stored only when it is unambiguous. It
 * then prices the new address from `jne_rates` and shows what the shipping
 * would become.
 *
 * DRY RUN by default, and the dry run IS the preview: it prints every address
 * change and every rate change and writes nothing. --commit applies exactly
 * what it printed.
 *
 *   npx tsx --env-file=.env.local scripts/import-address-corrections.ts fix.csv
 *   npx tsx --env-file=.env.local scripts/import-address-corrections.ts fix.csv --commit
 *   npx tsx --env-file=.env.local scripts/import-address-corrections.ts fix.csv --commit --keep-rates
 */

import { readFileSync } from "node:fs"
import sql from "@/lib/db-pool"
import { parseCsv } from "@/lib/csv"
import { searchAreas, BiteshipNotConfiguredError } from "@/lib/biteship"
import { matchArea, matchByPostal } from "@/lib/biteship-area-match"
import { getWarehouses, lookupOngkir } from "@/lib/db"

const argv = process.argv.slice(2)
const COMMIT = argv.includes("--commit")
/** Leave every ongkir exactly as it is, however the address changed. */
const KEEP_RATES = argv.includes("--keep-rates")
const csvPath = argv.find((a) => a.endsWith(".csv"))

const rupiah = (n: number) => `Rp ${new Intl.NumberFormat("id-ID").format(n)}`

async function main() {
  if (!csvPath) {
    console.error("Give me the CSV: scripts/import-address-corrections.ts fix.csv")
    process.exit(1)
  }
  const rows = parseCsv(readFileSync(csvPath, "utf8"))
  const header = rows[0]?.map((h) => h.trim().toLowerCase()) ?? []
  const col = (name: string) => header.indexOf(name)
  const iHandle = col("handle"), iKota = col("kota"), iKec = col("kecamatan"), iPos = col("kode_pos")
  if (iHandle < 0 || iKota < 0 || iKec < 0 || iPos < 0) {
    console.error("The file needs handle, kota, kecamatan and kode_pos columns.")
    process.exit(1)
  }

  const warehouses = await getWarehouses()
  console.log(COMMIT ? "APPLYING changes.\n" : "DRY RUN — nothing will be written.\n")

  let changed = 0, unchanged = 0, missing = 0, mapped = 0, repriced = 0
  for (const row of rows.slice(1)) {
    const handle = (row[iHandle] ?? "").trim().toLowerCase().replace(/@/g, "")
    if (!handle) continue
    const kota = (row[iKota] ?? "").trim()
    const kecamatan = (row[iKec] ?? "").trim()
    const kodePos = (row[iPos] ?? "").trim()

    const [customer] = (await sql`
      SELECT id, COALESCE(kota, '') AS kota, COALESCE(kecamatan, '') AS kecamatan,
             COALESCE(kode_pos, '') AS kode_pos
        FROM customers
       WHERE lower(replace(instagram_id, '@', '')) = ${handle}
    `) as unknown as { id: number; kota: string; kecamatan: string; kode_pos: string }[]
    if (!customer) { missing++; console.log(`?  ${handle} — no such customer`); continue }

    const moved = kota !== customer.kota || kecamatan !== customer.kecamatan || kodePos !== customer.kode_pos
    if (!moved) { unchanged++; continue }
    changed++
    console.log(
      `→  ${handle}\n` +
      `     ${customer.kota} / ${customer.kecamatan} ${customer.kode_pos}\n` +
      `     ${kota} / ${kecamatan} ${kodePos}`,
    )

    // The area, on the same rules as the backfill. Silence is an answer: an
    // address nobody can place keeps no area at all rather than a nearby guess.
    let areaId: string | null = null
    let areaName: string | null = null
    if (kota && kecamatan) {
      try {
        const areas = await searchAreas(`${kecamatan}, ${kota}`)
        const first = areas.length
          ? matchArea(areas, { kota, kecamatan, kodePos })
          : { kind: "none" as const }
        if (first.kind === "matched" && !first.approximate) {
          areaId = first.area.id; areaName = first.area.name
        } else if (kodePos) {
          const second = matchByPostal(await searchAreas(kodePos), { kota, kecamatan, kodePos })
          if (second.kind === "matched") { areaId = second.area.id; areaName = second.area.name }
        }
      } catch (err) {
        if (err instanceof BiteshipNotConfiguredError) throw err
      }
    }
    if (areaId) { mapped++; console.log(`     area: ${areaName}`) }
    else console.log(`     area: still nothing — the district and the code do not agree`)

    // What the rates table now says. Shown either way; written unless told not
    // to. A district with no row prices 0, which is not free shipping.
    const newRates: { warehouseId: number; code: string; rate: number; current: number }[] = []
    if (!KEEP_RATES && kota && kecamatan) {
      for (const w of warehouses) {
        const rate = await lookupOngkir(w.code, kota, kecamatan)
        const [cur] = (await sql`
          SELECT ongkos_kirim::int AS rate FROM customer_warehouse_ongkir
           WHERE customer_id = ${customer.id} AND warehouse_id = ${w.id}
        `) as unknown as { rate: number }[]
        const current = cur?.rate ?? 0
        if (rate > 0 && rate !== current) newRates.push({ warehouseId: w.id, code: w.code, rate, current })
      }
      for (const r of newRates) {
        console.log(`     ongkir ${r.code}: ${r.current ? rupiah(r.current) : "—"} → ${rupiah(r.rate)}`)
      }
      if (newRates.length) repriced++
    }

    if (!COMMIT) continue

    await sql`
      UPDATE customers
         SET kota = ${kota}, kecamatan = ${kecamatan}, kode_pos = ${kodePos},
             biteship_area_id = ${areaId}, biteship_area_name = ${areaName},
             updated_at = NOW()
       WHERE id = ${customer.id}
    `
    for (const r of newRates) {
      await sql`
        INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim, updated_at)
        VALUES (${customer.id}, ${r.warehouseId}, ${r.rate}, NOW())
        ON CONFLICT (customer_id, warehouse_id)
        DO UPDATE SET ongkos_kirim = EXCLUDED.ongkos_kirim, updated_at = NOW()
      `
    }
  }

  console.log(
    `\n${changed} addresses corrected, ${mapped} of them now resolve to an area, ` +
    `${repriced} would change an ongkir. ${unchanged} untouched, ${missing} handles not found.`,
  )
  if (!COMMIT) console.log("\nNothing written. Re-run with --commit to apply exactly this.")
  await sql.end()
}

main().catch(async (err) => {
  console.error("Import failed:", err)
  await sql.end()
  process.exit(1)
})
