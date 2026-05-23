import sql from "../db-pool"
import { tsToString } from "./helpers"
import type { ProductRow, ProductIndoRow, CountryRow } from "./types"

// ─── Products Indo ──────────────────────────────────────────────────────────

export async function getProductIndo(): Promise<ProductIndoRow[]> {
  const rows = await sql`
    SELECT id, product, store, price, created_at, updated_at FROM products_indo
    WHERE product != '' ORDER BY id ASC
  `
  return rows.map((r) => ({
    rowNumber: r.id,
    product: r.product,
    store: r.store,
    price: r.price ?? 0,
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
  }))
}

export async function addProductIndo(data: {
  product: string
  store: string
  price: number
}): Promise<{ rowNumber: number }> {
  const [row] = await sql`
    INSERT INTO products_indo (product, store, price)
    VALUES (${data.product}, ${data.store}, ${data.price})
    RETURNING id
  `
  return { rowNumber: row.id }
}

export async function updateProductIndo(
  rowNumber: number,
  data: { product: string; store: string; price: number },
): Promise<void> {
  await sql`
    UPDATE products_indo
    SET product = ${data.product}, store = ${data.store}, price = ${data.price},
        updated_at = NOW()
    WHERE id = ${rowNumber}
  `
}

// ─── Products (abroad + domestic) ─────────────────────────────────────────

export async function getProducts(): Promise<ProductRow[]> {
  const rows = await sql`
    SELECT p.id, p.name, p.store, p.price, p.gram,
           p.country_id, COALESCE(c.name, '') AS country_name,
           p.valas, p.kurs, p.cargo_per_kg, p.profit_pct,
           p.operational_fee, p.packing_fee, p.cost, p.profit_fixed,
           p.created_at, p.updated_at
    FROM products p
    LEFT JOIN countries c ON c.id = p.country_id
    WHERE p.name != ''
    ORDER BY p.name
  `
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    store: r.store ?? "",
    price: r.price ?? 0,
    gram: r.gram ?? 0,
    countryId: r.country_id,
    countryName: r.country_name ?? "",
    valas: Number(r.valas) || 0,
    kurs: r.kurs ?? 0,
    cargoPerKg: r.cargo_per_kg ?? 0,
    profitPct: r.profit_pct ?? 0,
    operationalFee: r.operational_fee ?? 5000,
    packingFee: r.packing_fee ?? 5000,
    cost: r.cost ?? 0,
    profitFixed: r.profit_fixed ?? 0,
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
  }))
}

export async function addProduct(data: {
  name: string
  store: string
  price: number
  gram: number
  countryId: number | null
  valas: number
  kurs: number
  cargoPerKg: number
  profitPct: number
  operationalFee: number
  packingFee: number
  cost: number
  profitFixed: number
}): Promise<{ id: number }> {
  const [row] = await sql`
    INSERT INTO products (name, store, price, gram, country_id, valas, kurs,
      cargo_per_kg, profit_pct, operational_fee, packing_fee, cost, profit_fixed)
    VALUES (${data.name}, ${data.store}, ${data.price}, ${data.gram},
      ${data.countryId}, ${data.valas}, ${data.kurs}, ${data.cargoPerKg},
      ${data.profitPct}, ${data.operationalFee}, ${data.packingFee},
      ${data.cost}, ${data.profitFixed})
    RETURNING id
  `
  return { id: row.id }
}

export async function updateProduct(
  id: number,
  data: {
    name: string
    store: string
    price: number
    gram: number
    countryId: number | null
    valas: number
    kurs: number
    cargoPerKg: number
    profitPct: number
    operationalFee: number
    packingFee: number
    cost: number
    profitFixed: number
  },
): Promise<void> {
  await sql`
    UPDATE products
    SET name = ${data.name}, store = ${data.store}, price = ${data.price},
        gram = ${data.gram}, country_id = ${data.countryId},
        valas = ${data.valas}, kurs = ${data.kurs}, cargo_per_kg = ${data.cargoPerKg},
        profit_pct = ${data.profitPct}, operational_fee = ${data.operationalFee},
        packing_fee = ${data.packingFee}, cost = ${data.cost},
        profit_fixed = ${data.profitFixed}, updated_at = NOW()
    WHERE id = ${id}
  `
}

export async function deleteProduct(id: number): Promise<void> {
  await sql`DELETE FROM products WHERE id = ${id}`
}

// ─── Countries ─────────────────────────────────────────────────────────────

export async function getCountries(): Promise<CountryRow[]> {
  const rows = await sql`
    SELECT id, name, currency, kurs, cargo_per_kg, created_at, updated_at
    FROM countries ORDER BY name
  `
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    currency: r.currency ?? "",
    kurs: r.kurs ?? 0,
    cargoPerKg: r.cargo_per_kg ?? 0,
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
  }))
}

export async function addCountry(data: {
  name: string
  currency: string
  kurs: number
  cargoPerKg: number
}): Promise<{ id: number }> {
  const [row] = await sql`
    INSERT INTO countries (name, currency, kurs, cargo_per_kg)
    VALUES (${data.name}, ${data.currency}, ${data.kurs}, ${data.cargoPerKg})
    RETURNING id
  `
  return { id: row.id }
}

export async function updateCountry(
  id: number,
  data: { name: string; currency: string; kurs: number; cargoPerKg: number },
): Promise<void> {
  await sql`
    UPDATE countries
    SET name = ${data.name}, currency = ${data.currency},
        kurs = ${data.kurs}, cargo_per_kg = ${data.cargoPerKg},
        updated_at = NOW()
    WHERE id = ${id}
  `
}

export async function deleteCountry(id: number): Promise<void> {
  await sql`DELETE FROM countries WHERE id = ${id}`
}

// ─── Events ───────────────────────────────────────────────────────────────

export interface EventRow {
  id: number
  name: string
  eta: string
  createdAt: string
  updatedAt: string
}

export async function getEvents(): Promise<EventRow[]> {
  const rows = await sql`
    SELECT id, name, eta, created_at, updated_at
    FROM events
    ORDER BY id DESC
  `
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    eta: r.eta ?? "",
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
  }))
}

export async function addEvent(data: {
  name: string
  eta: string
}): Promise<{ id: number }> {
  const [row] = await sql`
    INSERT INTO events (name, eta)
    VALUES (${data.name}, ${data.eta})
    RETURNING id
  `
  return { id: row.id }
}

export async function updateEvent(
  id: number,
  data: { name: string; eta: string },
): Promise<void> {
  await sql`
    UPDATE events
    SET name = ${data.name}, eta = ${data.eta}, updated_at = NOW()
    WHERE id = ${id}
  `
}

export async function deleteEvent(id: number): Promise<void> {
  await sql`DELETE FROM events WHERE id = ${id}`
}

