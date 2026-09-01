import sql from "../db-pool"
import { normalizeId } from "./helpers"
import { composeLabel, canCompose } from "../address"
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

/**
 * Group the per-warehouse rates by customer id, so each customer row can carry
 * its own map.
 *
 * Two maps, not one. `effective` is what a parcel is priced at and what the
 * list must show, so that reading a rate here and reading an invoice give the
 * same number. `fallback` is the raw `ongkos_kirim`, which the editor needs
 * because it is the only one of the two that can be written — seeding an edit
 * form from the effective rate would quietly copy a courier quote into our own
 * table the moment somebody pressed Save.
 */
function groupOngkirByCustomer(ongkirRows: readonly Record<string, unknown>[]): {
  effective: Map<number, OngkirByWarehouse>
  fallback: Map<number, OngkirByWarehouse>
} {
  const effective = new Map<number, OngkirByWarehouse>()
  const fallback = new Map<number, OngkirByWarehouse>()
  for (const o of ongkirRows) {
    const cid = o.customer_id as number
    const wid = o.warehouse_id as number

    const eff = effective.get(cid) ?? {}
    eff[wid] = (o.effective_ongkir as number) ?? 0
    effective.set(cid, eff)

    const fall = fallback.get(cid) ?? {}
    fall[wid] = (o.ongkos_kirim as number) ?? 0
    fallback.set(cid, fall)
  }
  return { effective, fallback }
}

function mapCustomerRow(
  r: Record<string, unknown>,
  ongkir: OngkirByWarehouse,
  ongkirFallback: OngkirByWarehouse,
): CustomerRow {
  return {
    id: r.id as number,
    instagramId: (r.instagram_id as string) ?? "",
    name: (r.name as string) ?? "",
    whatsapp: (r.whatsapp as string) ?? "",
    dataDiri: (r.data_diri as string) ?? "",
    ekspedisi: (r.ekspedisi as string) ?? "",
    ongkir,
    ongkirFallback,
    bankName: (r.bank_name as string) ?? "",
    bankAccountNumber: (r.bank_account_number as string) ?? "",
    bankAccountHolder: (r.bank_account_holder as string) ?? "",
    jalan: (r.jalan as string) ?? "",
    kota: (r.kota as string) ?? "",
    kecamatan: (r.kecamatan as string) ?? "",
    provinsi: (r.provinsi as string) ?? "",
    kodePos: (r.kode_pos as string) ?? "",
    biteshipAreaId: (r.biteship_area_id as string) ?? null,
    biteshipAreaName: (r.biteship_area_name as string) ?? null,
    // Present only when the query joined customer_invoice_summary; otherwise 0.
    invoiceCount: Number(r.invoice_count ?? 0),
    totalInvoiced: Number(r.total_invoiced ?? 0),
    totalOutstanding: Number(r.total_outstanding ?? 0),
    // Presence only. The Google account's address is deliberately never
    // stored, so this can say whether they can sign in but not who as.
    catalogueSignedIn: r.google_sub != null,
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
             jalan, kota, kecamatan, provinsi, kode_pos,
             biteship_area_id, biteship_area_name,
             bank_name, bank_account_number, bank_account_holder,
             google_sub, created_at, updated_at
      FROM customers
      ORDER BY instagram_id ASC
    `,
    sql`SELECT customer_id, warehouse_id, ongkos_kirim, effective_ongkir FROM customer_warehouse_ongkir`,
  ])

  const ongkirByCustomer = groupOngkirByCustomer(ongkirRows)
  return rows.map((r) => mapCustomerRow(
      r,
      ongkirByCustomer.effective.get(r.id as number) ?? {},
      ongkirByCustomer.fallback.get(r.id as number) ?? {},
    ))
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
  /** Balance-status filter over the invoice roll-up. Only customers with at
   *  least one (non-void) invoice qualify. */
  balanceStatus?: "outstanding" | "overpayment" | "settled"
  /** Filter one warehouse's ongkir column (the grid's dynamic `ongkir_<id>`
   *  columns), e.g. "only customers whose ongkir to warehouse 3 is >= 20000". */
  ongkirWarehouseId?: number
  ongkirOp?: "eq" | "gt" | "lt" | "gte" | "lte"
  ongkirValue?: number
}): Promise<PaginatedCustomers> {
  const { page, pageSize, search, skipCount } = opts
  const offset = (page - 1) * pageSize

  const conditions: string[] = []
  const params: (string | number)[] = []

  if (search) {
    params.push(`%${search.toLowerCase()}%`)
    const p = `$${params.length}`
    conditions.push(
      `(lower(c.instagram_id) LIKE ${p} OR lower(COALESCE(c.name,'')) LIKE ${p} OR ` +
        `lower(COALESCE(c.whatsapp,'')) LIKE ${p} OR lower(COALESCE(c.ekspedisi,'')) LIKE ${p} OR ` +
        `lower(COALESCE(c.data_diri,'')) LIKE ${p} OR lower(COALESCE(c.bank_name,'')) LIKE ${p})`,
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
      conditions.push(`lower(COALESCE(c.${col},'')) LIKE $${params.length}`)
    }
  }

  // The dynamic per-warehouse ongkir columns aren't on `customers` — they need
  // customer_warehouse_ongkir joined for the ONE warehouse being sorted/filtered
  // (not all of them, or every page load would join once per warehouse). Sort
  // and filter reuse the same join when they target the same warehouse.
  const sortOngkirMatch = opts.sortKey?.match(/^ongkir_(\d+)$/)
  const sortWarehouseId = sortOngkirMatch ? Number(sortOngkirMatch[1]) : null
  const filterWarehouseId = opts.ongkirWarehouseId ?? null
  const sameWarehouse = sortWarehouseId != null && sortWarehouseId === filterWarehouseId

  let joinSql = ""
  let sortOngkirExpr: string | null = null
  let filterOngkirExpr: string | null = null

  if (sameWarehouse) {
    params.push(sortWarehouseId!)
    joinSql = ` LEFT JOIN customer_warehouse_ongkir ongkir_sf ON ongkir_sf.customer_id = c.id AND ongkir_sf.warehouse_id = $${params.length}`
    sortOngkirExpr = "COALESCE(ongkir_sf.effective_ongkir, 0)"
    filterOngkirExpr = "COALESCE(ongkir_sf.effective_ongkir, 0)"
  } else {
    if (sortWarehouseId != null) {
      params.push(sortWarehouseId)
      joinSql += ` LEFT JOIN customer_warehouse_ongkir ongkir_sort ON ongkir_sort.customer_id = c.id AND ongkir_sort.warehouse_id = $${params.length}`
      sortOngkirExpr = "COALESCE(ongkir_sort.effective_ongkir, 0)"
    }
    if (filterWarehouseId != null) {
      params.push(filterWarehouseId)
      joinSql += ` LEFT JOIN customer_warehouse_ongkir ongkir_filter ON ongkir_filter.customer_id = c.id AND ongkir_filter.warehouse_id = $${params.length}`
      filterOngkirExpr = "COALESCE(ongkir_filter.effective_ongkir, 0)"
    }
  }

  const OP_SQL: Record<string, string> = { eq: "=", gt: ">", lt: "<", gte: ">=", lte: "<=" }
  if (filterOngkirExpr && opts.ongkirOp && OP_SQL[opts.ongkirOp] && opts.ongkirValue != null && Number.isFinite(opts.ongkirValue)) {
    params.push(opts.ongkirValue)
    conditions.push(`${filterOngkirExpr} ${OP_SQL[opts.ongkirOp]} $${params.length}`)
  }

  // Invoice roll-up join — always present so the grid can sort by total invoiced
  // and filter by balance status. No params (keyed on the canonical handle).
  joinSql += ` LEFT JOIN customer_invoice_summary cis ON cis.cust_key = lower(replace(c.instagram_id, '@', ''))`
  if (opts.balanceStatus === "outstanding") {
    conditions.push(`COALESCE(cis.invoice_count, 0) > 0 AND COALESCE(cis.total_outstanding, 0) > 0`)
  } else if (opts.balanceStatus === "overpayment") {
    conditions.push(`COALESCE(cis.invoice_count, 0) > 0 AND COALESCE(cis.total_outstanding, 0) < 0`)
  } else if (opts.balanceStatus === "settled") {
    conditions.push(`COALESCE(cis.invoice_count, 0) > 0 AND COALESCE(cis.total_outstanding, 0) = 0`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

  const SORT_COLUMNS: Record<string, string> = {
    instagramId: "c.instagram_id", name: "c.name", whatsapp: "c.whatsapp",
    ekspedisi: "c.ekspedisi", dataDiri: "c.data_diri", bankName: "c.bank_name",
    createdAt: "c.created_at", updatedAt: "c.updated_at",
    totalInvoiced: "COALESCE(cis.total_invoiced, 0)",
    invoiceCount: "COALESCE(cis.invoice_count, 0)",
    totalOutstanding: "COALESCE(cis.total_outstanding, 0)",
  }
  const sortCol = sortOngkirExpr ?? ((opts.sortKey && SORT_COLUMNS[opts.sortKey]) || "c.instagram_id")
  const sortDir = opts.sortDir === "desc" ? "DESC" : "ASC"

  const dataRows = await sql.unsafe(
    `SELECT c.id, c.instagram_id, c.name, c.whatsapp, c.data_diri, c.ekspedisi,
            c.bank_name, c.bank_account_number, c.bank_account_holder,
            c.jalan, c.kota, c.kecamatan, c.provinsi, c.kode_pos,
            c.biteship_area_id, c.biteship_area_name,
            c.google_sub, c.created_at, c.updated_at,
            COALESCE(cis.invoice_count, 0) AS invoice_count,
            COALESCE(cis.total_invoiced, 0) AS total_invoiced,
            COALESCE(cis.total_outstanding, 0) AS total_outstanding
     FROM customers c
     ${joinSql}
     ${where}
     ORDER BY ${sortCol} ${sortDir}, c.id ${sortDir}
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )

  // Ongkir only for the page's customers, plus the count (skipped when paging
  // within an unchanged query shape).
  const pageIds = dataRows.map((r) => r.id as number)
  const [ongkirRows, countRows] = await Promise.all([
    pageIds.length
      ? sql`SELECT customer_id, warehouse_id, ongkos_kirim, effective_ongkir FROM customer_warehouse_ongkir WHERE customer_id = ANY(${pageIds})`
      : Promise.resolve([] as Record<string, unknown>[]),
    skipCount
      ? Promise.resolve(null)
      : sql.unsafe(`SELECT COUNT(*)::int AS total FROM customers c ${joinSql} ${where}`, params),
  ])

  const ongkirByCustomer = groupOngkirByCustomer(ongkirRows)
  const rows = dataRows.map((r) => mapCustomerRow(
      r,
      ongkirByCustomer.effective.get(r.id as number) ?? {},
      ongkirByCustomer.fallback.get(r.id as number) ?? {},
    ))

  if (!countRows) {
    return {
      rows,
      totalCount: CUSTOMERS_TOTAL_COUNT_UNCHANGED,
      page,
      pageSize,
      totalPages: CUSTOMERS_TOTAL_COUNT_UNCHANGED,
    }
  }

  const totalCount = Number((countRows as Record<string, unknown>[])[0]?.total ?? 0)
  return {
    rows,
    totalCount,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
  }
}

/**
 * The label text, made from her parts when they can say it.
 *
 * `data_diri` is what the shipping label prints, and it used to be typed --
 * her name written a second time, her district a third, nothing keeping any of
 * them in step. Now the parts are the truth and this is generated from them.
 *
 * Only where the parts CAN say it. A row whose street nobody could recover
 * keeps the text it prints today: composing without a street would put her
 * district on the parcel and lose the house.
 */
function labelFor(data: CustomerInput): string {
  const parts = {
    name: data.name, whatsapp: data.whatsapp, jalan: data.jalan ?? "",
    kecamatan: data.kecamatan ?? "", kota: data.kota ?? "",
    provinsi: data.provinsi ?? "", kodePos: data.kodePos ?? "",
    areaName: data.biteshipAreaName ?? "",
  }
  return canCompose(parts) ? composeLabel(parts) : data.dataDiri
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
      jalan, kota, kecamatan, provinsi, kode_pos,
      biteship_area_id, biteship_area_name,
      bank_name, bank_account_number, bank_account_holder
    ) VALUES (
      ${instagramId}, ${data.name}, ${data.whatsapp}, ${labelFor(data)}, ${data.ekspedisi},
      ${data.jalan ?? ""}, ${data.kota ?? ""}, ${data.kecamatan ?? ""},
      ${data.provinsi ?? ""}, ${data.kodePos ?? ""},
      ${data.biteshipAreaId ?? null}, ${data.biteshipAreaName ?? null},
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
        data_diri           = ${labelFor(data)},
        ekspedisi           = ${data.ekspedisi},
        bank_name           = ${data.bankName},
        bank_account_number = ${data.bankAccountNumber},
        bank_account_holder = ${data.bankAccountHolder},
        updated_at          = NOW()
    WHERE id = ${id}
  `
  // Her address, only from a screen that asked for it.
  //
  // A separate statement rather than more columns above: every other caller of
  // this function -- the add form, the bank-details save -- has never had these
  // fields, and folding them in would blank the address the catalogue set every
  // time somebody corrected a bank account.
  if (data.kota !== undefined || data.kecamatan !== undefined || data.kodePos !== undefined) {
    // The stored quote belongs to the area it was bought for. Changing the area
    // and leaving the quote beside it is how seven corrected customers kept
    // being priced to the towns they had left on 30 Aug 2026 -- `iinkaila` was
    // moved from Medan to Pondok Aren and still carried Medan's 47.000.
    // Read first: only clear when the area actually changed, so an edit to a
    // bank account does not throw away a quote somebody paid for.
    const [prev] = (await db`
      SELECT biteship_area_id AS area FROM customers WHERE id = ${id}
    `) as unknown as { area: string | null }[]
    if ((prev?.area ?? null) !== (data.biteshipAreaId ?? null)) {
      await db`
        UPDATE customer_warehouse_ongkir
           SET biteship_ongkir = NULL, biteship_quoted_at = NULL
         WHERE customer_id = ${id}
      `
    }
    await db`
      UPDATE customers
      SET jalan     = ${data.jalan ?? ""},
          kota      = ${data.kota ?? ""},
          kecamatan = ${data.kecamatan ?? ""},
          provinsi  = ${data.provinsi ?? ""},
          kode_pos  = ${data.kodePos ?? ""},
          -- Cleared when the address changes and nobody named an area: the old
          -- one belonged to the old address, and a stale area is worse than
          -- none. It is what prices a redirect and what the courier is told.
          biteship_area_id   = ${data.biteshipAreaId ?? null},
          biteship_area_name = ${data.biteshipAreaName ?? null},
          updated_at         = NOW()
      WHERE id = ${id}
    `
  }
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
/**
 * The rates table's own spelling of a district, from the courier's.
 *
 * Biteship writes "Limo, Depok"; `jne_rates` has "LIMO, KOTA DEPOK". Neither is
 * wrong -- but `lookupOngkir` matches on exact strings, and NONE of the 663
 * districts our customers live in exist under Biteship's spelling. So filling
 * the address fields with what the area says would fill them with a district
 * that cannot be priced.
 *
 * Matching on letters alone gets past all of it: "JatiSampurna" finds
 * "JATISAMPURNA", "Depok" finds "KOTA DEPOK". 550 of 570 districts resolve to
 * exactly one row; the rest are left to a person, because a rate is a price
 * somebody pays.
 */
export async function resolveRatesDistrict(
  kecamatan: string,
  kota: string,
  db: DBExecutor = sql,
): Promise<{ kecamatan: string; kota: string } | null> {
  const letters = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "")
  const kec = letters(kecamatan)
  const kab = letters(kota)
  if (!kec || !kab) return null
  const rows = (await db`
    SELECT DISTINCT kecamatan_nama, kab_kota_nama
      FROM jne_rates
     WHERE regexp_replace(upper(kecamatan_nama), '[^A-Z0-9]', '', 'g') = ${kec}
       AND regexp_replace(upper(kab_kota_nama), '[^A-Z0-9]', '', 'g') LIKE ${`%${kab}%`}
     LIMIT 2
  `) as unknown as { kecamatan_nama: string; kab_kota_nama: string }[]
  // Exactly one, or it has not chosen: two districts of the same name in one
  // province is a question, not a fill.
  if (rows.length !== 1) return null
  return { kecamatan: rows[0].kecamatan_nama.trim(), kota: rows[0].kab_kota_nama.trim() }
}

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
  /** The form has always collected these; until now it only pasted them into
   *  data_diri and threw the fields away. */
  jalan?: string
  provinsi?: string
  /** The courier's own id for her address, chosen on the form. */
  biteshipAreaId?: string | null
  biteshipAreaName?: string | null
}): Promise<{ id: number; created: boolean }> {
  const norm = normalizeId(data.instagramId)

  // Where she says she lives now, against where we had her. A customer
  // re-registers BECAUSE she moved, and until 31 Aug 2026 this function
  // updated her district and her rate while leaving `biteship_area_id` and
  // `biteship_ongkir` pointing at the city she left. Harmless while the
  // invoice prices from `ongkos_kirim`; once it prices from the quote, it
  // would bill her to the old city forever, silently.
  const [before] = (await sql`
    SELECT kota, kecamatan FROM customers
     WHERE lower(replace(instagram_id, '@', '')) = ${norm}
  `) as unknown as { kota: string | null; kecamatan: string | null }[]
  const letters = (v: string) => (v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
  const moved = before != null &&
    (letters(before.kota ?? "") !== letters(data.kota) ||
     letters(before.kecamatan ?? "") !== letters(data.kecamatan))

  // Her area comes from the form when it could name one. Where it could not --
  // Biteship carries no area for the district, or the lookup was down -- a MOVE
  // still has to drop the old one: no area prices from `jne_rates`, which is
  // right, while a stale area prices to the wrong town, which is not.
  const keepArea = data.biteshipAreaId === undefined && !moved

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
      jalan        = ${data.jalan ?? ""},
      provinsi     = ${data.provinsi ?? ""},
      ${keepArea ? sql`` : sql`
      biteship_area_id   = ${data.biteshipAreaId ?? null},
      biteship_area_name = ${data.biteshipAreaName ?? null},`}
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
      INSERT INTO customers (instagram_id, name, whatsapp, data_diri, ekspedisi,
                             kota, kecamatan, kode_pos, jalan, provinsi,
                             biteship_area_id, biteship_area_name)
      VALUES (${norm}, ${data.name}, ${data.whatsapp}, ${data.dataDiri}, ${data.ekspedisi},
              ${data.kota}, ${data.kecamatan}, ${data.kodePos},
              ${data.jalan ?? ""}, ${data.provinsi ?? ""},
              ${data.biteshipAreaId ?? null}, ${data.biteshipAreaName ?? null})
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

  // A quote belongs to the area it was bought for. She has moved, so it does
  // not describe her any more -- drop it and let the next sweep re-ask. The
  // rate written just above carries her until then.
  if (moved) {
    await sql`
      UPDATE customer_warehouse_ongkir
         SET biteship_ongkir = NULL, biteship_quoted_at = NULL
       WHERE customer_id = ${id}
    `
  }

  return { id, created }
}

