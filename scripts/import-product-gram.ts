/**
 * Import product gram (weight) from Google Sheets → Supabase
 *
 * Reads the "Product" tab, matches existing products by (name, store),
 * and updates the gram column.
 *
 * Usage:
 *   node --env-file=.env.local --import=tsx scripts/import-product-gram.ts
 *
 * Required env vars:
 *   DATABASE_URL
 *   GOOGLE_SPREADSHEET_ID
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
 */

import { google } from "googleapis"
import postgres from "postgres"

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set")
  process.exit(1)
}
if (!process.env.GOOGLE_SPREADSHEET_ID) {
  console.error("GOOGLE_SPREADSHEET_ID is not set")
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 })

function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  })
  return google.sheets({ version: "v4", auth })
}

async function main() {
  const sheets = getSheetsClient()
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID!

  // Read Product tab — columns: PRODUCT, STORE, IDR, GRAM
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Product!A:D",
  })
  const rows = (res.data.values ?? []) as string[][]

  // Skip header row
  const dataRows = rows.slice(1).filter((r) => r[0]?.trim())

  console.log(`Read ${dataRows.length} products from Google Sheets`)

  let updated = 0
  let skipped = 0
  const notFound: string[] = []

  for (const row of dataRows) {
    const name = row[0]?.trim() ?? ""
    const store = row[1]?.trim() ?? ""
    const gram = parseInt(row[3] ?? "0", 10) || 0

    if (!name) continue

    const result = await sql`
      UPDATE products SET gram = ${gram}
      WHERE name = ${name} AND store = ${store}
    `

    if (result.count > 0) {
      updated++
    } else {
      skipped++
      notFound.push(`${name} | ${store}`)
    }
  }

  console.log(`\nDone:`)
  console.log(`  Updated: ${updated}`)
  console.log(`  Not found in DB: ${skipped}`)

  if (notFound.length > 0) {
    console.log(`\nProducts not found in Supabase (no match by name+store):`)
    for (const p of notFound) {
      console.log(`  - ${p}`)
    }
  }

  await sql.end()
}

main().catch((err) => {
  console.error("Failed:", err)
  process.exit(1)
})
