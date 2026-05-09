/**
 * Import payments from Google Sheets "Payment" tab → Supabase payments table.
 *
 * Sheet columns: Event, Customer, Payment, Account, Check, Date, Remarks
 *
 * Usage:
 *   node --env-file=.env.local --import=tsx scripts/import-payments.ts
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

/** Normalize customer handle to @lowercase */
function normalizeCustomer(raw: string): string {
  const lower = raw.trim().toLowerCase()
  return lower.startsWith("@") ? lower : `@${lower}`
}

async function main() {
  const sheets = getSheetsClient()
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID!

  // Read Payment tab — columns: A=Event, B=Customer, C=Payment, D=Account, E=Check, F=Date, G=Remarks
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Payment!A:G",
  })
  const rows = (res.data.values ?? []) as string[][]

  // Skip header row
  const dataRows = rows.slice(1).filter((r) => r[0]?.trim() && r[1]?.trim())

  console.log(`Read ${dataRows.length} payment rows from Google Sheets`)

  // Auto-create customer records for any new customers
  const uniqueCustomers = [...new Set(dataRows.map((r) => normalizeCustomer(r[1])))]
  await sql`
    INSERT INTO customers (instagram_id)
    VALUES ${sql(uniqueCustomers.map((c) => [c]))}
    ON CONFLICT (instagram_id) DO NOTHING
  `

  // Auto-create event records for any new events
  const uniqueEvents = [...new Set(dataRows.map((r) => r[0].trim()).filter(Boolean))]
  await sql`
    INSERT INTO events (name)
    VALUES ${sql(uniqueEvents.map((e) => [e]))}
    ON CONFLICT (name) DO NOTHING
  `

  let inserted = 0
  let skipped = 0

  for (const row of dataRows) {
    const event = row[0]?.trim() ?? ""
    const customer = normalizeCustomer(row[1])
    const amount = parseInt((row[2] ?? "0").replace(/,/g, ""), 10) || 0
    const account = row[3]?.trim() ?? ""
    const isChecked = (row[4] ?? "").toUpperCase() === "TRUE"
    const rawDate = row[5]?.trim() ?? ""
    // Convert "20-Jan" → "2026-01-20" for DATE column; leave empty as null
    let payDate: string | null = null
    if (rawDate) {
      const parsed = new Date(`${rawDate}-2026`)
      if (!isNaN(parsed.getTime())) {
        payDate = parsed.toISOString().slice(0, 10)
      }
    }
    const remarks = row[6]?.trim() ?? ""

    if (!event || !customer) {
      skipped++
      continue
    }

    await sql`
      INSERT INTO payments (event, customer, amount, account, is_checked, pay_date, remarks)
      VALUES (${event}, ${customer}, ${amount}, ${account}, ${isChecked}, ${payDate}, ${remarks})
    `
    inserted++
  }

  console.log(`\nDone:`)
  console.log(`  Inserted: ${inserted}`)
  console.log(`  Skipped (missing event/customer): ${skipped}`)

  await sql.end()
}

main().catch((err) => {
  console.error("Failed:", err)
  process.exit(1)
})
