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

  // Group the per-warehouse rates by customer so each row carries its full map.
  const ongkirByCustomer = new Map<number, OngkirByWarehouse>()
  for (const o of ongkirRows) {
    const cid = o.customer_id as number
    const map = ongkirByCustomer.get(cid) ?? {}
    map[o.warehouse_id as number] = (o.ongkos_kirim as number) ?? 0
    ongkirByCustomer.set(cid, map)
  }

  return rows.map((r) => ({
    id: r.id as number,
    instagramId: r.instagram_id ?? "",
    name: r.name ?? "",
    whatsapp: r.whatsapp ?? "",
    dataDiri: r.data_diri ?? "",
    ekspedisi: r.ekspedisi ?? "",
    ongkir: ongkirByCustomer.get(r.id as number) ?? {},
    bankName: r.bank_name ?? "",
    bankAccountNumber: r.bank_account_number ?? "",
    bankAccountHolder: r.bank_account_holder ?? "",
    createdAt: r.created_at ? new Date(r.created_at as string).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at as string).toISOString() : null,
  }))
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

