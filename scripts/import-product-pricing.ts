/**
 * Import product pricing data from Google Sheets "Product_Percentage" tab
 * into the Supabase products table.
 *
 * Matches rows by (name, store, price) and fills in:
 *   valas, gram, kurs, cargo_per_kg, profit_pct, country_id
 * Operational fee and packing fee keep their defaults (5000 each).
 *
 * Usage:
 *   node --env-file=.env.local --import=tsx scripts/import-product-pricing.ts
 *
 * Optional flags:
 *   --dry-run   Print what would be updated without writing to DB
 *
 * Required env vars:
 *   DATABASE_URL
 *   GOOGLE_PRODUCT_INDO_SPREADSHEET_ID
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
 */

import { google } from "googleapis"
import postgres from "postgres"

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set")
  process.exit(1)
}
if (!process.env.GOOGLE_PRODUCT_INDO_SPREADSHEET_ID) {
  console.error("GOOGLE_PRODUCT_INDO_SPREADSHEET_ID is not set")
  process.exit(1)
}

const dryRun = process.argv.includes("--dry-run")
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

  // Read all rows from the Product_Percentage sheet
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_PRODUCT_INDO_SPREADSHEET_ID,
    range: "Product_Percentage!A:K",
  })

  const rows = res.data.values
  if (!rows || rows.length < 2) {
    console.log("No data found in Product_Percentage sheet")
    await sql.end()
    return
  }

  // Parse header to find column indices
  const header = rows[0].map((h: string) => String(h).trim().toUpperCase())
  const colMap: Record<string, number> = {}
  for (let i = 0; i < header.length; i++) {
    colMap[header[i]] = i
  }

  // Map header names to expected columns
  const COL_ITEMS = colMap["ITEMS"] ?? colMap["ITEM"] ?? 0
  const COL_PRICE = colMap["IDR"] ?? colMap["PRICE"] ?? 1
  const COL_STORE = colMap["STORE"] ?? 2
  const COL_VLS = colMap["VLS"] ?? colMap["VALAS"] ?? 3
  const COL_GRAM = colMap["GRAM"] ?? colMap["GRAMS"] ?? 4
  const COL_PCT = colMap["%"] ?? colMap["# %"] ?? 5
  const COL_CN = colMap["CN"] ?? colMap["COUNTRY"] ?? 8
  const COL_KURS = colMap["KURS"] ?? 9
  const COL_CARGO = colMap["CARGO"] ?? 10

  console.log("Column mapping:", {
    ITEMS: COL_ITEMS,
    IDR: COL_PRICE,
    STORE: COL_STORE,
    VLS: COL_VLS,
    GRAM: COL_GRAM,
    "%": COL_PCT,
    CN: COL_CN,
    KURS: COL_KURS,
    CARGO: COL_CARGO,
  })

  // Fetch all countries from DB to map names to IDs
  const countriesDb = await sql`SELECT id, name FROM countries`
  const countryMap = new Map<string, number>()
  for (const c of countriesDb) {
    countryMap.set(c.name.toUpperCase(), c.id)
  }
  console.log("Countries in DB:", [...countryMap.entries()].map(([k, v]) => `${k}=${v}`).join(", "))

  // Fetch all products from DB
  const productsDb = await sql`SELECT id, name, store, price FROM products`
  // Build lookup key: lowercase "name|store|price"
  const productLookup = new Map<string, number>()
  for (const p of productsDb) {
    const key = `${p.name.toLowerCase()}|${p.store.toLowerCase()}|${p.price}`
    productLookup.set(key, p.id)
  }
  console.log(`Loaded ${productsDb.length} products from DB\n`)

  // Parse sheet rows
  const cell = (row: string[], col: number): string => String(row[col] ?? "").trim()
  const cellNum = (row: string[], col: number): number => {
    const raw = cell(row, col).replace(/,/g, "")
    return Number(raw) || 0
  }

  let matched = 0
  let skipped = 0
  let notFound = 0
  const updates: {
    id: number
    valas: number
    gram: number
    kurs: number
    cargoPerKg: number
    profitPct: number
    countryId: number | null
  }[] = []

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const name = cell(row, COL_ITEMS)
    const store = cell(row, COL_STORE)
    const price = cellNum(row, COL_PRICE)

    if (!name) {
      skipped++
      continue
    }

    const key = `${name.toLowerCase()}|${store.toLowerCase()}|${price}`
    const productId = productLookup.get(key)

    if (productId === undefined) {
      console.warn(`  NOT FOUND: "${name}" | "${store}" | ${price}`)
      notFound++
      continue
    }

    const valas = cellNum(row, COL_VLS)
    const gram = cellNum(row, COL_GRAM)
    const profitPct = cellNum(row, COL_PCT)
    const countryCode = cell(row, COL_CN).toUpperCase()
    const kurs = cellNum(row, COL_KURS)
    const cargoPerKg = cellNum(row, COL_CARGO)

    const countryId = countryCode ? (countryMap.get(countryCode) ?? null) : null
    if (countryCode && countryId === null) {
      console.warn(`  UNKNOWN COUNTRY "${countryCode}" for product "${name}" (row ${i + 1})`)
    }

    updates.push({ id: productId, valas, gram, kurs, cargoPerKg, profitPct, countryId })
    matched++
  }

  console.log(`\nParsed ${rows.length - 1} rows: ${matched} matched, ${notFound} not found, ${skipped} skipped (empty)`)

  if (dryRun) {
    console.log("\n--- DRY RUN — no changes written ---")
    for (const u of updates.slice(0, 10)) {
      console.log(`  Product #${u.id}: valas=${u.valas} gram=${u.gram} kurs=${u.kurs} cargo=${u.cargoPerKg} pct=${u.profitPct} country=${u.countryId}`)
    }
    if (updates.length > 10) console.log(`  ... and ${updates.length - 10} more`)
    await sql.end()
    return
  }

  // Apply updates in a transaction
  console.log(`\nUpdating ${updates.length} products...`)
  await sql.begin(async (tx) => {
    for (const u of updates) {
      await tx`
        UPDATE products
        SET valas = ${u.valas},
            gram = ${u.gram},
            kurs = ${u.kurs},
            cargo_per_kg = ${u.cargoPerKg},
            profit_pct = ${u.profitPct},
            country_id = ${u.countryId}
        WHERE id = ${u.id}
      `
    }
  })

  console.log(`Done! Updated ${updates.length} products.`)
  await sql.end()
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
