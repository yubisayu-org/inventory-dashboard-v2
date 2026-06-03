import sql from "../db-pool"
import { normalizeId } from "./helpers"
import type { DBExecutor } from "./actor"
import type { CustomerDetail, CustomerRow, CustomerInput, OngkirByWarehouse } from "./types"

// ─── Customers ──────────────────────────────────────────────────────────────

/**
 * Write a customer's per-warehouse shipping rates into customer_warehouse_ongkir.
 * Upsert so re-saving a customer updates existing rates without wiping ones for
 * warehouses not present in the input. ongkir is keyed by warehouse id.
 */
async function upsertCustomerOngkir(
  customerId: number,
  ongkir: OngkirByWarehouse,
  db: DBExecutor = sql,
): Promise<void> {
  const entries = Object.entries(ongkir)
  for (const [warehouseId, value] of entries) {
    await db`
      INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim, updated_at)
      VALUES (${customerId}, ${Number(warehouseId)}, ${Number(value) || 0}, NOW())
      ON CONFLICT (customer_id, warehouse_id)
      DO UPDATE SET ongkos_kirim = EXCLUDED.ongkos_kirim, updated_at = NOW()
    `
  }
}

/**
 * Coerce a request-body ongkir object ({ [warehouseId]: value }) into a clean
 * per-warehouse map, dropping malformed keys/values. Shared by the add/edit
 * customer API routes.
 */
export function parseOngkir(input: unknown): OngkirByWarehouse {
  const out: OngkirByWarehouse = {}
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const wid = Number(k)
      const val = Number(v)
      if (Number.isInteger(wid) && wid > 0) out[wid] = Number.isFinite(val) ? Math.trunc(val) : 0
    }
  }
  return out
}

export async function lookupCustomerDetail(instagramId: string): Promise<CustomerDetail | null> {
  const searchId = normalizeId(instagramId)
  const rows = await sql`
    SELECT name, whatsapp, data_diri, ekspedisi,
           bank_name, bank_account_number, bank_account_holder
    FROM customers
    WHERE lower(replace(instagram_id, '@', '')) = ${searchId}
    LIMIT 1
  `
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    name: r.name ?? "",
    whatsapp: r.whatsapp ?? "",
    dataDiri: r.data_diri ?? "",
    ekspedisi: r.ekspedisi ?? "",
    bankName: r.bank_name ?? "",
    bankAccountNumber: r.bank_account_number ?? "",
    bankAccountHolder: r.bank_account_holder ?? "",
  }
}

export async function updateCustomerBankInfo(
  instagramId: string,
  data: { bankName: string; bankAccountNumber: string; bankAccountHolder: string },
  db: DBExecutor = sql,
): Promise<void> {
  const searchId = normalizeId(instagramId)
  await db`
    UPDATE customers
    SET bank_name           = ${data.bankName},
        bank_account_number = ${data.bankAccountNumber},
        bank_account_holder = ${data.bankAccountHolder},
        updated_at          = NOW()
    WHERE lower(replace(instagram_id, '@', '')) = ${searchId}
  `
}

/** Group the per-warehouse rates by customer id, so each customer row can carry its own map. */
function groupOngkirByCustomer(
  ongkirRows: readonly Record<string, unknown>[],
): Map<number, OngkirByWarehouse> {
  const byCustomer = new Map<number, OngkirByWarehouse>()
  for (const o of ongkirRows) {
    const cid = o.customer_id as number
    const map = byCustomer.get(cid) ?? {}
    map[o.warehouse_id as number] = (o.ongkos_kirim as number) ?? 0
    byCustomer.set(cid, map)
  }
  return byCustomer
}

function mapCustomerRow(r: Record<string, unknown>, ongkir: OngkirByWarehouse): CustomerRow {
  return {
    id: r.id as number,
    instagramId: (r.instagram_id as string) ?? "",
    name: (r.name as string) ?? "",
    whatsapp: (r.whatsapp as string) ?? "",
    dataDiri: (r.data_diri as string) ?? "",
    ekspedisi: (r.ekspedisi as string) ?? "",
    ongkir,
    bankName: (r.bank_name as string) ?? "",
    bankAccountNumber: (r.bank_account_number as string) ?? "",
    bankAccountHolder: (r.bank_account_holder as string) ?? "",
    createdAt: r.created_at ? new Date(r.created_at as string).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at as string).toISOString() : null,
  }
}

/**
 * Full customer list (every row + every warehouse's ongkir). Kept for callers
 * that need the whole set; the dashboard list now uses getCustomersPaginated so
 * it doesn't load every customer's address/bank text on each visit.
 */
export async function getCustomers(): Promise<CustomerRow[]> {
  const [rows, ongkirRows] = await Promise.all([
    sql`
      SELECT id, instagram_id, name, whatsapp, data_diri, ekspedisi,
             bank_name, bank_account_number, bank_account_holder,
             created_at, updated_at
      FROM customers
      ORDER BY instagram_id ASC
    `,
    sql`SELECT customer_id, warehouse_id, ongkos_kirim FROM customer_warehouse_ongkir`,
  ])

  const ongkirByCustomer = groupOngkirByCustomer(ongkirRows)
  return rows.map((r) => mapCustomerRow(r, ongkirByCustomer.get(r.id as number) ?? {}))
}

export interface PaginatedCustomers {
  rows: CustomerRow[]
  totalCount: number
  page: number
  pageSize: number
  totalPages: number
}

/** Sentinel for totalCount/totalPages when skipCount was requested (see usePaginatedFetch). */
export const CUSTOMERS_TOTAL_COUNT_UNCHANGED = -1

/**
 * One page of customers with server-side search/filter/sort. Only the page's
 * rows — and the ongkir for just those customers — cross the wire, so address
 * and bank text for the whole table no longer load on every visit. Mirrors
 * getProductsPaginated / getDuplicateFormRowsPaginated.
 */
export async function getCustomersPaginated(opts: {
  page: number
  pageSize: number
  search?: string
  instagramId?: string
  name?: string
  whatsapp?: string
  ekspedisi?: string
  dataDiri?: string
  bankName?: string
  sortKey?: string
  sortDir?: "asc" | "desc"
  skipCount?: boolean
}): Promise<PaginatedCustomers> {
  const { page, pageSize, search, skipCount } = opts
  const offset = (page - 1) * pageSize

  const conditions: string[] = []
  const params: (string | number)[] = []

  if (search) {
    params.push(`%${search.toLowerCase()}%`)
    const p = `$${params.length}`
    conditions.push(
      `(lower(instagram_id) LIKE ${p} OR lower(COALESCE(name,'')) LIKE ${p} OR ` +
        `lower(COALESCE(whatsapp,'')) LIKE ${p} OR lower(COALESCE(ekspedisi,'')) LIKE ${p} OR ` +
        `lower(COALESCE(data_diri,'')) LIKE ${p} OR lower(COALESCE(bank_name,'')) LIKE ${p})`,
    )
  }

  // Per-column "contains" filters from the grid headers.
  const colFilters: [string | undefined, string][] = [
    [opts.instagramId, "instagram_id"],
    [opts.name, "name"],
    [opts.whatsapp, "whatsapp"],
    [opts.ekspedisi, "ekspedisi"],
    [opts.dataDiri, "data_diri"],
    [opts.bankName, "bank_name"],
  ]
  for (const [value, col] of colFilters) {
    if (value) {
      params.push(`%${value.toLowerCase()}%`)
      conditions.push(`lower(COALESCE(${col},'')) LIKE $${params.length}`)
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

  const SORT_COLUMNS: Record<string, string> = {
    instagramId: "instagram_id", name: "name", whatsapp: "whatsapp",
    ekspedisi: "ekspedisi", dataDiri: "data_diri", bankName: "bank_name",
    createdAt: "created_at", updatedAt: "updated_at",
  }
  const sortCol = (opts.sortKey && SORT_COLUMNS[opts.sortKey]) || "instagram_id"
  const sortDir = opts.sortDir === "desc" ? "DESC" : "ASC"

  const dataRows = await sql.unsafe(
    `SELECT id, instagram_id, name, whatsapp, data_diri, ekspedisi,
            bank_name, bank_account_number, bank_account_holder,
            created_at, updated_at
     FROM customers
     ${where}
     ORDER BY ${sortCol} ${sortDir}, id ${sortDir}
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )

  // Ongkir only for the page's customers, plus the count (skipped when paging
  // within an unchanged query shape).
  const pageIds = dataRows.map((r) => r.id as number)
  const [ongkirRows, countRows] = await Promise.all([
    pageIds.length
      ? sql`SELECT customer_id, warehouse_id, ongkos_kirim FROM customer_warehouse_ongkir WHERE customer_id = ANY(${pageIds})`
      : Promise.resolve([] as Record<string, unknown>[]),
    skipCount
      ? Promise.resolve(null)
      : sql.unsafe(`SELECT COUNT(*)::int AS c FROM customers ${where}`, params),
  ])

  const ongkirByCustomer = groupOngkirByCustomer(ongkirRows)
  const rows = dataRows.map((r) => mapCustomerRow(r, ongkirByCustomer.get(r.id as number) ?? {}))

  if (!countRows) {
    return {
      rows,
      totalCount: CUSTOMERS_TOTAL_COUNT_UNCHANGED,
      page,
      pageSize,
      totalPages: CUSTOMERS_TOTAL_COUNT_UNCHANGED,
    }
  }

  const totalCount = Number((countRows as Record<string, unknown>[])[0]?.c ?? 0)
  return {
    rows,
    totalCount,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
  }
}

export async function addCustomer(data: CustomerInput, db: DBExecutor = sql): Promise<{ id: number }> {
  // Canonical form is bare lowercase, no '@'. Without this, "@User" and "user"
  // would each create their own row and the order flow (which normalizes the
  // handle on insert) would attach orders to a different row than the one the
  // admin filled out.
  const instagramId = normalizeId(data.instagramId)
  const rows = await db`
    INSERT INTO customers (
      instagram_id, name, whatsapp, data_diri, ekspedisi,
      bank_name, bank_account_number, bank_account_holder
    ) VALUES (
      ${instagramId}, ${data.name}, ${data.whatsapp}, ${data.dataDiri}, ${data.ekspedisi},
      ${data.bankName}, ${data.bankAccountNumber}, ${data.bankAccountHolder}
    )
    RETURNING id
  `
  const id = rows[0].id as number
  await upsertCustomerOngkir(id, data.ongkir, db)
  return { id }
}

export async function updateCustomer(id: number, data: CustomerInput, db: DBExecutor = sql): Promise<void> {
  const instagramId = normalizeId(data.instagramId)
  await db`
    UPDATE customers
    SET instagram_id        = ${instagramId},
        name                = ${data.name},
        whatsapp            = ${data.whatsapp},
        data_diri           = ${data.dataDiri},
        ekspedisi           = ${data.ekspedisi},
        bank_name           = ${data.bankName},
        bank_account_number = ${data.bankAccountNumber},
        bank_account_holder = ${data.bankAccountHolder},
        updated_at          = NOW()
    WHERE id = ${id}
  `
  await upsertCustomerOngkir(id, data.ongkir, db)
}

export async function deleteCustomer(id: number, db: DBExecutor = sql): Promise<void> {
  await db`DELETE FROM customers WHERE id = ${id}`
}

// ─── Public registration ──────────────────────────────────────────────────────

/**
 * JNE rate from a given origin warehouse to a destination, matched on the
 * (origin, city, district) triple. 0 = no rate. Each warehouse ships from a
 * different origin city, so the same destination resolves to a different price
 * per origin (see jne_rates.origin_code in migration 032).
 */
export async function lookupOngkir(
  originCode: string,
  kabKota: string,
  kecamatan: string,
): Promise<number> {
  if (!originCode?.trim() || !kabKota?.trim() || !kecamatan?.trim()) return 0
  const rows = await sql`
    SELECT final_price
    FROM jne_rates
    WHERE upper(trim(origin_code))    = upper(trim(${originCode}))
      AND upper(trim(kab_kota_nama))  = upper(trim(${kabKota}))
      AND upper(trim(kecamatan_nama)) = upper(trim(${kecamatan}))
    LIMIT 1
  `
  return rows.length ? (rows[0].final_price as number) : 0
}

/**
 * Register a self-registered customer, keyed on the normalized handle (so "@User"
 * and "user" don't create duplicate rows).
 *
 * Re-submission is expected behavior — the form tells users to re-register when
 * their address changes — so an existing row's contact fields (name/whatsapp/
 * data_diri/ekspedisi) and per-warehouse ongkir are overwritten with the latest
 * submission. Bank info is never touched here; that lives behind the
 * authenticated dashboard.
 *
 * Ongkir is resolved per warehouse: the destination (kota, kecamatan) is matched
 * against each warehouse origin's JNE rate set, so every warehouse gets its own
 * customer_warehouse_ongkir row.
 */
export async function registerCustomer(data: {
  instagramId: string
  name: string
  whatsapp: string
  dataDiri: string
  ekspedisi: string
  kota: string
  kecamatan: string
  kodePos: string
}): Promise<{ id: number; created: boolean }> {
  const norm = normalizeId(data.instagramId)
  // Persist the destination so future warehouses can re-derive ongkir without
  // re-collecting it (see migration 034).
  const updated = await sql`
    UPDATE customers SET
      name         = ${data.name},
      whatsapp     = ${data.whatsapp},
      data_diri    = ${data.dataDiri},
      ekspedisi    = ${data.ekspedisi},
      kota         = ${data.kota},
      kecamatan    = ${data.kecamatan},
      kode_pos     = ${data.kodePos},
      updated_at   = NOW()
    WHERE lower(replace(instagram_id, '@', '')) = ${norm}
    RETURNING id
  `

  let id: number
  let created: boolean
  if (updated.length) {
    id = updated[0].id as number
    created = false
  } else {
    const inserted = await sql`
      INSERT INTO customers (instagram_id, name, whatsapp, data_diri, ekspedisi, kota, kecamatan, kode_pos)
      VALUES (${norm}, ${data.name}, ${data.whatsapp}, ${data.dataDiri}, ${data.ekspedisi},
              ${data.kota}, ${data.kecamatan}, ${data.kodePos})
      RETURNING id
    `
    id = inserted[0].id as number
    created = true
  }

  // Resolve and store a rate per warehouse from its own origin's JNE rate set.
  const warehouses = await sql`SELECT id, code FROM warehouses`
  const ongkir: OngkirByWarehouse = {}
  for (const w of warehouses) {
    ongkir[w.id as number] = await lookupOngkir(w.code as string, data.kota, data.kecamatan)
  }
  await upsertCustomerOngkir(id, ongkir)

  return { id, created }
}

