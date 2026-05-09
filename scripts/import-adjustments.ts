/**
 * Import adjustments (biaya lainnya) from Google Sheets
 * "Order_JanganDisort_DifilterAja" tab → Supabase adjustments table.
 *
 * Reads the header row to find Event, Customer, and Lainnya columns.
 * Groups by (event, customer) and inserts one adjustment row per unique
 * pair where Lainnya != 0.
 *
 * Usage:
 *   node --env-file=.env.local --import=tsx scripts/import-adjustments.ts
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

function normalizeCustomer(raw: string): string {
  const lower = raw.trim().toLowerCase()
  return lower.startsWith("@") ? lower : `@${lower}`
}

async function main() {
  const sheets = getSheetsClient()
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID!

  console.log("Reading Order_JanganDisort_DifilterAja sheet...")
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Order_JanganDisort_DifilterAja",
  })

  const allRows = res.data.values ?? []
  if (allRows.length < 2) {
    console.error("Sheet is empty or has no data rows")
    process.exit(1)
  }

  const headers = allRows[0].map((h: string) => h.trim())
  const dataRows = allRows.slice(1)

  // Find column indices from header row
  const eventCol = headers.findIndex((h: string) => /^event$/i.test(h))
  const customerCol = headers.findIndex((h: string) => /^customer$/i.test(h))
  const lainnyaCol = headers.findIndex((h: string) => /lainnya/i.test(h))

  if (eventCol === -1 || customerCol === -1 || lainnyaCol === -1) {
    console.error("Could not find required columns in header row.")
    console.error(`  Event column: ${eventCol === -1 ? "NOT FOUND" : `index ${eventCol}`}`)
    console.error(`  Customer column: ${customerCol === -1 ? "NOT FOUND" : `index ${customerCol}`}`)
    console.error(`  Lainnya column: ${lainnyaCol === -1 ? "NOT FOUND" : `index ${lainnyaCol}`}`)
    console.error(`  Headers found: ${headers.join(", ")}`)
    process.exit(1)
  }

  console.log(`Found columns — Event: ${eventCol}, Customer: ${customerCol}, Lainnya: ${lainnyaCol}`)
  console.log(`Processing ${dataRows.length} data rows...`)

  // Group by (event, customer) → take the Lainnya value
  const adjustments = new Map<string, { event: string; customer: string; amount: number }>()

  for (const row of dataRows) {
    const event = (row[eventCol] ?? "").trim()
    const customer = normalizeCustomer(row[customerCol] ?? "")
    const rawLainnya = (row[lainnyaCol] ?? "").toString().replace(/,/g, "").trim()
    const amount = parseInt(rawLainnya, 10) || 0

    if (!event || !customer || amount === 0) continue

    const key = `${event}|||${customer}`
    if (!adjustments.has(key)) {
      adjustments.set(key, { event, customer, amount })
    }
    // If already seen, the value should be the same per (event, customer)
  }

  console.log(`Found ${adjustments.size} unique (event, customer) adjustments`)

  let inserted = 0
  let skipped = 0

  for (const { event, customer, amount } of adjustments.values()) {
    try {
      // Ensure customer exists
      await sql`
        INSERT INTO customers (instagram_id) VALUES (${customer})
        ON CONFLICT (instagram_id) DO NOTHING
      `
      await sql`
        INSERT INTO adjustments (event, customer, description, amount)
        VALUES (${event}, ${customer}, ${"Biaya Lainnya"}, ${amount})
      `
      inserted++
    } catch (err) {
      console.warn(`  ⚠ Skipped (${event}, ${customer}): ${err instanceof Error ? err.message : err}`)
      skipped++
    }
  }

  console.log(`\nDone:`)
  console.log(`  Inserted: ${inserted}`)
  if (skipped > 0) console.log(`  Skipped: ${skipped}`)

  await sql.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
