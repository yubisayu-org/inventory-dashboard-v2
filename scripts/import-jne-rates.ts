/**
 * Import JNE shipping rates: CSV (exported from the `Database_JNE` sheet) → Supabase `jne_rates`.
 *
 * Re-runnable: TRUNCATEs and reloads the whole table. The CSV is bulky, re-importable
 * reference data and is gitignored (scripts/data/).
 *
 * Usage:
 *   node --env-file=.env.local --import=tsx scripts/import-jne-rates.ts scripts/data/database_jne.csv
 *
 * Required env var:
 *   DATABASE_URL — Supabase pooler connection string
 *
 * The CSV is mapped BY HEADER NAME, so extra exported columns (COUNTIF,
 * kecamatan_nama_code, …) are ignored. Expected headers:
 *   provinsi_nama, kab_kota_nama, kecamatan_nama,
 *   village_postal_codes, bs_jne_reg_duration, final_price
 */

import { readFileSync } from "node:fs"
import postgres from "postgres"

const csvPath = process.argv[2]

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set")
  process.exit(1)
}
if (!csvPath) {
  console.error("❌ Usage: import-jne-rates.ts <path-to-csv>")
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 })

// final_price is quoted with a thousands comma in the export (e.g. "76,000").
function parseNum(v: string | undefined): number {
  if (!v || !v.trim()) return 0
  return Number(String(v).replace(/[^0-9.-]/g, "")) || 0
}

// Minimal RFC-4180 parser: handles quoted fields, embedded commas, and "" escapes.
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ",") {
      row.push(field); field = ""
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = ""
    } else if (c !== "\r") {
      field += c
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

async function main() {
  const rows = parseCsv(readFileSync(csvPath, "utf8"))
  if (rows.length < 2) {
    console.error("❌ CSV has no data rows")
    process.exit(1)
  }

  const header = rows[0].map((h) => h.trim())
  const col = (name: string) => {
    const idx = header.indexOf(name)
    if (idx === -1) {
      console.error(`❌ CSV is missing required column "${name}". Headers: ${header.join(", ")}`)
      process.exit(1)
    }
    return idx
  }
  const iProv = col("provinsi_nama")
  const iKab = col("kab_kota_nama")
  const iKec = col("kecamatan_nama")
  const iPostal = col("village_postal_codes")
  const iDur = col("bs_jne_reg_duration")
  const iPrice = col("final_price")

  const records = rows.slice(1)
    .filter((r) => r.length > 1 && r[iKab]?.trim() && r[iKec]?.trim())
    .map((r) => ({
      provinsi_nama: (r[iProv] ?? "").trim(),
      kab_kota_nama: (r[iKab] ?? "").trim(),
      kecamatan_nama: (r[iKec] ?? "").trim(),
      village_postal_codes: (r[iPostal] ?? "").trim(),
      reg_duration: (r[iDur] ?? "").trim(),
      final_price: parseNum(r[iPrice]),
    }))

  console.log(`Parsed ${records.length} rate rows from ${csvPath}`)

  await sql`TRUNCATE jne_rates RESTART IDENTITY`

  const BATCH = 1000
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH)
    await sql`INSERT INTO jne_rates ${sql(batch)}`
    console.log(`  inserted ${Math.min(i + BATCH, records.length)} / ${records.length}`)
  }

  const [{ count }] = await sql`SELECT count(*)::int AS count FROM jne_rates`
  console.log(`✅ Done. jne_rates now has ${count} rows.`)
  await sql.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
