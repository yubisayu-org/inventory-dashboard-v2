/**
 * Convert pay_date TEXT values from "{day}-{month}" (e.g. "20-Jan")
 * to ISO date strings "{year}-{mm}-{dd}" (e.g. "2026-01-20").
 *
 * Run this BEFORE migration 008 which changes the column type to DATE.
 *
 * Usage:
 *   node --env-file=.env.local --import=tsx scripts/convert-pay-dates.ts 2026
 */

import postgres from "postgres"

const year = process.argv[2]
if (!year || !/^\d{4}$/.test(year)) {
  console.error("Usage: npx tsx scripts/convert-pay-dates.ts <year>")
  console.error("  e.g. npx tsx scripts/convert-pay-dates.ts 2026")
  process.exit(1)
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set")
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 })

async function main() {
  // Find all rows with non-empty text pay_date that look like "{day}-{month}"
  const rows = await sql`
    SELECT id, pay_date FROM payments
    WHERE pay_date != '' AND pay_date !~ '^\d{4}-\d{2}-\d{2}$'
  `

  if (rows.length === 0) {
    console.log("No rows to convert — all pay_date values are already ISO format or empty.")
    await sql.end()
    return
  }

  console.log(`Found ${rows.length} rows with "{day}-{month}" format. Converting with year ${year}...`)

  let converted = 0
  let failed = 0

  for (const row of rows) {
    const raw = row.pay_date as string // e.g. "20-Jan"
    const parsed = new Date(`${raw}-${year}`)

    if (isNaN(parsed.getTime())) {
      console.warn(`  ⚠ Row ${row.id}: could not parse "${raw}" — skipping`)
      failed++
      continue
    }

    const iso = parsed.toISOString().slice(0, 10) // "2026-01-20"
    await sql`UPDATE payments SET pay_date = ${iso} WHERE id = ${row.id}`
    converted++
  }

  console.log(`\nDone:`)
  console.log(`  Converted: ${converted}`)
  if (failed > 0) console.log(`  Failed: ${failed}`)

  await sql.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
