/**
 * The customers whose address the courier cannot place, as a spreadsheet.
 *
 * 80 of them, each needing a person to read one address and say which field is
 * wrong — her district or her postal code. That is 80 modals one at a time, or
 * one file where the whole problem is visible at once, which is why this
 * exists.
 *
 * Every column except the three editable ones is there to decide WITH: what
 * the lookup made of her address, what we charge per kilo, and what the
 * courier quotes. A row where both readings cost the same is a row that can be
 * fixed carelessly; a row where they differ is one to think about.
 *
 * Editable: kota, kecamatan, kode_pos. Everything else is ignored on the way
 * back in — see import-address-corrections.ts.
 *
 *   npx tsx --env-file=.env.local scripts/export-unmapped-addresses.ts
 *   npx tsx --env-file=.env.local scripts/export-unmapped-addresses.ts --out /tmp/fix.csv --no-lookup
 */

import { writeFileSync } from "node:fs"
import sql from "@/lib/db-pool"
import { toCsv } from "@/lib/csv"
import { searchAreas, BiteshipNotConfiguredError } from "@/lib/biteship"
import { matchArea, matchByPostal } from "@/lib/biteship-area-match"

const argv = process.argv.slice(2)
const out = argv[argv.indexOf("--out") + 1]?.endsWith(".csv")
  ? argv[argv.indexOf("--out") + 1]
  : "scripts/data/unmapped-addresses.csv"
/** Skip the billable searches and export the addresses on their own. */
const NO_LOOKUP = argv.includes("--no-lookup")

async function main() {
  // The quote column arrives with migration 120. The file is useful without
  // it, so its absence drops a column rather than the export.
  const [hasQuote] = (await sql`
    SELECT 1 AS ok FROM information_schema.columns
     WHERE table_name = 'customer_warehouse_ongkir' AND column_name = 'biteship_ongkir'
  `) as unknown as { ok: number }[]
  if (!hasQuote) console.log("No biteship_ongkir column yet — the jne_per_kg column will be blank.")

  const rows = (await sql.unsafe(`
    SELECT c.id, lower(replace(c.instagram_id, '@', '')) AS handle, c.name,
           COALESCE(c.kota, '') AS kota, COALESCE(c.kecamatan, '') AS kecamatan,
           COALESCE(c.kode_pos, '') AS kode_pos,
           cwo.ongkos_kirim::int AS ours,
           ${hasQuote ? "cwo.biteship_ongkir::int" : "NULL::int"} AS jne
      FROM customers c
      LEFT JOIN customer_warehouse_ongkir cwo
        ON cwo.customer_id = c.id AND cwo.warehouse_id = 1
     WHERE COALESCE(c.biteship_area_id, '') = ''
     ORDER BY (COALESCE(c.kecamatan, '') = ''), c.kota, c.kecamatan, handle
  `)) as unknown as {
    id: number; handle: string; name: string | null
    kota: string; kecamatan: string; kode_pos: string
    ours: number | null; jne: number | null
  }[]

  console.log(`${rows.length} customers with no Biteship area.`)

  // One search per DISTINCT district, as everywhere else — the file has many
  // customers sharing a place and each search is billed.
  const seen = new Map<string, string>()
  const lookupFor = async (r: (typeof rows)[number]) => {
    if (NO_LOOKUP || !r.kecamatan || !r.kota) return ""
    const key = `${r.kecamatan}|${r.kota}|${r.kode_pos}`
    const cached = seen.get(key)
    if (cached !== undefined) return cached
    let answer = ""
    try {
      const areas = await searchAreas(`${r.kecamatan}, ${r.kota}`)
      const first = areas.length ? matchArea(areas, {
        kota: r.kota, kecamatan: r.kecamatan, kodePos: r.kode_pos,
      }) : { kind: "none" as const }
      if (first.kind === "matched") {
        answer = first.area.name + (first.approximate ? " (district only)" : "")
      } else if (r.kode_pos) {
        const byCode = await searchAreas(r.kode_pos)
        const second = matchByPostal(byCode, {
          kota: r.kota, kecamatan: r.kecamatan, kodePos: r.kode_pos,
        })
        answer = second.kind === "matched"
          ? second.area.name
          : byCode.length
            ? `code points at: ${byCode.slice(0, 2).map((a) => a.name).join(" | ")}`
            : "nothing found"
      } else {
        answer = "nothing found"
      }
    } catch (err) {
      if (err instanceof BiteshipNotConfiguredError) throw err
      answer = "lookup failed"
    }
    seen.set(key, answer)
    return answer
  }

  const table: (string | number | null)[][] = [[
    "handle", "name", "kota", "kecamatan", "kode_pos",
    "lookup_says", "ours_per_kg", "jne_per_kg",
  ]]
  let done = 0
  for (const r of rows) {
    if (++done % 25 === 0 || done === rows.length) console.log(`   … ${done}/${rows.length}`)
    table.push([
      r.handle, r.name ?? "", r.kota, r.kecamatan, r.kode_pos,
      await lookupFor(r), r.ours ?? "", r.jne ?? "",
    ])
  }

  writeFileSync(out, toCsv(table))
  console.log(`\nWritten to ${out}`)
  console.log("Edit kota / kecamatan / kode_pos only, then:")
  console.log(`   npx tsx --env-file=.env.local scripts/import-address-corrections.ts ${out}`)
  await sql.end()
}

main().catch(async (err) => {
  console.error("Export failed:", err)
  await sql.end()
  process.exit(1)
})
