/**
 * One-time migration script: Google Sheets → Supabase (Postgres)
 *
 * Usage:
 *   npx tsx scripts/migrate-sheets-to-supabase.ts
 *
 * Required env vars (set in .env.local or export in shell):
 *   DATABASE_URL                      — Supabase pooler connection string
 *   GOOGLE_SPREADSHEET_ID             — Main spreadsheet ID
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL      — Service account email
 *   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY — Service account private key
 *   GOOGLE_PRODUCT_INDO_SPREADSHEET_ID — Separate Product_Indo spreadsheet ID
 *
 * What it does:
 *   1. Reads all sheet tabs from Google Sheets
 *   2. Inserts into Supabase tables in dependency order
 *   3. Reports row counts for verification
 *
 * Safe to run multiple times — it truncates tables before inserting.
 */

import { google } from "googleapis"
import postgres from "postgres"
import { config } from "dotenv"

// Load .env.local (Next.js convention)
config({ path: ".env.local" })

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID!
const PRODUCT_INDO_SPREADSHEET_ID = process.env.GOOGLE_PRODUCT_INDO_SPREADSHEET_ID!

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set")
  process.exit(1)
}
if (!SPREADSHEET_ID) {
  console.error("❌ GOOGLE_SPREADSHEET_ID is not set")
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

async function readSheet(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  range: string,
): Promise<string[][]> {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range })
  return (res.data.values ?? []) as string[][]
}

// Parse "DD/MM/YYYY, HH.MM.SS" → ISO timestamp string (Asia/Jakarta = UTC+7)
function parseTimestamp(s: string | undefined): string | null {
  if (!s || !s.trim()) return null
  const match = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2})\.(\d{1,2})\.(\d{1,2})/)
  if (!match) return null
  const [, d, m, y, h, min, sec] = match
  const pad = (n: string) => n.padStart(2, "0")
  return `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:${pad(sec)}+07:00`
}

function parseNum(v: string | undefined): number {
  if (!v || !v.trim()) return 0
  return Number(String(v).replace(/[^0-9.-]/g, "")) || 0
}

function optionalNum(v: string | undefined): number | null {
  if (!v || !v.trim()) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function main() {
  const sheets = getSheetsClient()

  console.log("📖 Reading from Google Sheets...")

  const [eventsData, productsData, customersData, ordersData, excessData, shippingData, productIndoData] =
    await Promise.all([
      readSheet(sheets, SPREADSHEET_ID, "Events!A2:A"),
      readSheet(sheets, SPREADSHEET_ID, "Product!A2:C"),
      readSheet(sheets, SPREADSHEET_ID, "Customer!A2:E"),
      readSheet(sheets, SPREADSHEET_ID, "Duplicate_Form!A2:L"),
      readSheet(sheets, SPREADSHEET_ID, "Excess_Purchase!A2:F"),
      readSheet(sheets, SPREADSHEET_ID, "Shipping_table!A2:K"),
      PRODUCT_INDO_SPREADSHEET_ID
        ? readSheet(sheets, PRODUCT_INDO_SPREADSHEET_ID, "Product_Indo!A2:C")
        : Promise.resolve([]),
    ])

  console.log(`  Events: ${eventsData.length} rows`)
  console.log(`  Products: ${productsData.length} rows`)
  console.log(`  Customers: ${customersData.length} rows`)
  console.log(`  Orders (Duplicate_Form): ${ordersData.length} rows`)
  console.log(`  Excess Purchase: ${excessData.length} rows`)
  console.log(`  Shipments: ${shippingData.length} rows`)
  console.log(`  Products Indo: ${productIndoData.length} rows`)

  console.log("\n🗑️  Truncating existing tables...")
  await sql`TRUNCATE events, customers, products, products_indo, orders, excess_purchase, shipments RESTART IDENTITY CASCADE`

  // ─── Events ─────────────────────────────────────────────────────────────
  console.log("\n📥 Inserting events...")
  const events = eventsData
    .map((row) => row[0]?.trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i) // dedupe
  if (events.length > 0) {
    await sql`INSERT INTO events ${sql(events.map((name) => ({ name })))}`
  }
  console.log(`  ✓ ${events.length} events`)

  // ─── Customers ──────────────────────────────────────────────────────────
  console.log("\n📥 Inserting customers...")
  const customers = customersData
    .filter((row) => row[0]?.trim())
    .map((row) => ({
      instagram_id: String(row[0] ?? "").trim(),
      whatsapp: String(row[1] ?? "").trim(),
      data_diri: String(row[2] ?? "").trim(),
      ekspedisi: String(row[3] ?? "").trim(),
      ongkos_kirim: parseNum(row[4]),
    }))
  if (customers.length > 0) {
    // Some customers may have duplicate instagram_ids — take the first
    const seen = new Set<string>()
    const unique = customers.filter((c) => {
      const key = c.instagram_id.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    await sql`INSERT INTO customers ${sql(unique)}`
    console.log(`  ✓ ${unique.length} customers (${customers.length - unique.length} duplicates skipped)`)
  }

  // ─── Products ───────────────────────────────────────────────────────────
  console.log("\n📥 Inserting products...")
  const products = productsData
    .filter((row) => row[0]?.trim())
    .map((row) => ({
      name: String(row[0] ?? "").trim(),
      store: String(row[1] ?? "").trim(),
      price: parseNum(row[2]),
    }))
  if (products.length > 0) {
    await sql`INSERT INTO products ${sql(products)}`
  }
  console.log(`  ✓ ${products.length} products`)

  // ─── Products Indo ──────────────────────────────────────────────────────
  console.log("\n📥 Inserting products_indo...")
  const productsIndo = productIndoData
    .filter((row) => row[0]?.trim())
    .map((row) => ({
      product: String(row[0] ?? "").trim(),
      store: String(row[1] ?? "").trim(),
      price: parseNum(row[2]),
    }))
  if (productsIndo.length > 0) {
    await sql`INSERT INTO products_indo ${sql(productsIndo)}`
  }
  console.log(`  ✓ ${productsIndo.length} products_indo`)

  // ─── Orders (Duplicate_Form) ────────────────────────────────────────────
  console.log("\n📥 Inserting orders...")
  const orders = ordersData
    .filter((row) => row[0]?.trim() || row[1]?.trim() || row[2]?.trim())
    .map((row) => ({
      event: String(row[0] ?? "").trim(),
      customer: String(row[1] ?? "").trim(),
      items: String(row[2] ?? "").trim(),
      unit: parseNum(row[3]) || 0,
      note: String(row[4] ?? "").trim(),
      created_at: parseTimestamp(row[5]) ?? new Date().toISOString(),
      updated_at: parseTimestamp(row[6]),
      unit_buy: optionalNum(row[7]),
      receipt: String(row[8] ?? "").trim(),
      unit_arrive: optionalNum(row[9]),
      unit_ship: optionalNum(row[10]),
      unit_hold: optionalNum(row[11]),
    }))
  if (orders.length > 0) {
    // Insert in batches of 500 to avoid query size limits
    for (let i = 0; i < orders.length; i += 500) {
      const batch = orders.slice(i, i + 500)
      await sql`INSERT INTO orders ${sql(batch)}`
      if (orders.length > 500) {
        console.log(`  ... ${Math.min(i + 500, orders.length)}/${orders.length}`)
      }
    }
  }
  console.log(`  ✓ ${orders.length} orders`)

  // ─── Excess Purchase ────────────────────────────────────────────────────
  console.log("\n📥 Inserting excess_purchase...")
  const excess = excessData
    .filter((row) => row[0]?.trim() || row[1]?.trim())
    .map((row) => ({
      event: String(row[0] ?? "").trim(),
      items: String(row[1] ?? "").trim(),
      unit_buy: parseNum(row[2]) || 0,
      receipt: String(row[3] ?? "").trim(),
      created_at: parseTimestamp(row[4]) ?? new Date().toISOString(),
      updated_at: parseTimestamp(row[5]),
    }))
  if (excess.length > 0) {
    await sql`INSERT INTO excess_purchase ${sql(excess)}`
  }
  console.log(`  ✓ ${excess.length} excess_purchase`)

  // ─── Shipments ──────────────────────────────────────────────────────────
  console.log("\n📥 Inserting shipments...")
  const shipments = shippingData
    .filter((row) => row[2]?.trim()) // must have a shipping_id
    .map((row) => ({
      event: String(row[0] ?? "").trim(),
      customer: String(row[1] ?? "").trim(),
      shipping_id: String(row[2] ?? "").trim().padStart(4, "0"),
      invoicing: String(row[3] ?? "").trim(),
      weight_estimation: parseNum(row[4]),
      ongkir: parseNum(row[5]),
      ongkir_total: parseNum(row[6]),
      is_last_shipment: String(row[7] ?? "").toUpperCase() === "TRUE",
      created_at: parseTimestamp(row[8]) ?? new Date().toISOString(),
      updated_at: parseTimestamp(row[9]),
      tracking_number: String(row[10] ?? "").trim(),
    }))
  if (shipments.length > 0) {
    await sql`INSERT INTO shipments ${sql(shipments)}`
  }
  console.log(`  ✓ ${shipments.length} shipments`)

  // ─── Summary ────────────────────────────────────────────────────────────
  console.log("\n✅ Migration complete!\n")
  console.log("Summary:")
  console.log(`  events:          ${events.length}`)
  console.log(`  customers:       ${customers.length}`)
  console.log(`  products:        ${products.length}`)
  console.log(`  products_indo:   ${productsIndo.length}`)
  console.log(`  orders:          ${orders.length}`)
  console.log(`  excess_purchase: ${excess.length}`)
  console.log(`  shipments:       ${shipments.length}`)

  await sql.end()
}

main().catch((err) => {
  console.error("\n❌ Migration failed:", err)
  process.exit(1)
})
