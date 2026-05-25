import sql from "../db-pool"
import { normalizeId } from "./helpers"
import type { CustomerDetail, CustomerRow, CustomerInput } from "./types"

// ─── Customers ──────────────────────────────────────────────────────────────

export async function lookupCustomerDetail(instagramId: string): Promise<CustomerDetail | null> {
  const searchId = normalizeId(instagramId)
  const rows = await sql`
    SELECT whatsapp, data_diri, ekspedisi, ongkos_kirim,
           bank_name, bank_account_number, bank_account_holder
    FROM customers
    WHERE lower(replace(instagram_id, '@', '')) = ${searchId}
    LIMIT 1
  `
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    whatsapp: r.whatsapp ?? "",
    dataDiri: r.data_diri ?? "",
    ekspedisi: r.ekspedisi ?? "",
    ongkosKirim: r.ongkos_kirim ?? 0,
    bankName: r.bank_name ?? "",
    bankAccountNumber: r.bank_account_number ?? "",
    bankAccountHolder: r.bank_account_holder ?? "",
  }
}

export async function updateCustomerBankInfo(
  instagramId: string,
  data: { bankName: string; bankAccountNumber: string; bankAccountHolder: string },
): Promise<void> {
  const searchId = normalizeId(instagramId)
  await sql`
    UPDATE customers
    SET bank_name           = ${data.bankName},
        bank_account_number = ${data.bankAccountNumber},
        bank_account_holder = ${data.bankAccountHolder},
        updated_at          = NOW()
    WHERE lower(replace(instagram_id, '@', '')) = ${searchId}
  `
}

export async function getCustomers(): Promise<CustomerRow[]> {
  const rows = await sql`
    SELECT id, instagram_id, whatsapp, data_diri, ekspedisi, ongkos_kirim,
           bank_name, bank_account_number, bank_account_holder,
           created_at, updated_at
    FROM customers
    ORDER BY instagram_id ASC
  `
  return rows.map((r) => ({
    id: r.id as number,
    instagramId: r.instagram_id ?? "",
    whatsapp: r.whatsapp ?? "",
    dataDiri: r.data_diri ?? "",
    ekspedisi: r.ekspedisi ?? "",
    ongkosKirim: r.ongkos_kirim ?? 0,
    bankName: r.bank_name ?? "",
    bankAccountNumber: r.bank_account_number ?? "",
    bankAccountHolder: r.bank_account_holder ?? "",
    createdAt: r.created_at ? new Date(r.created_at as string).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at as string).toISOString() : null,
  }))
}

export async function addCustomer(data: CustomerInput): Promise<{ id: number }> {
  const rows = await sql`
    INSERT INTO customers (
      instagram_id, whatsapp, data_diri, ekspedisi, ongkos_kirim,
      bank_name, bank_account_number, bank_account_holder
    ) VALUES (
      ${data.instagramId}, ${data.whatsapp}, ${data.dataDiri}, ${data.ekspedisi}, ${data.ongkosKirim},
      ${data.bankName}, ${data.bankAccountNumber}, ${data.bankAccountHolder}
    )
    RETURNING id
  `
  return { id: rows[0].id as number }
}

export async function updateCustomer(id: number, data: CustomerInput): Promise<void> {
  await sql`
    UPDATE customers
    SET instagram_id        = ${data.instagramId},
        whatsapp            = ${data.whatsapp},
        data_diri           = ${data.dataDiri},
        ekspedisi           = ${data.ekspedisi},
        ongkos_kirim        = ${data.ongkosKirim},
        bank_name           = ${data.bankName},
        bank_account_number = ${data.bankAccountNumber},
        bank_account_holder = ${data.bankAccountHolder},
        updated_at          = NOW()
    WHERE id = ${id}
  `
}

export async function deleteCustomer(id: number): Promise<void> {
  await sql`DELETE FROM customers WHERE id = ${id}`
}

// ─── Public registration ──────────────────────────────────────────────────────

/** JNE rate for a destination, matched on the (city, district) pair. 0 = no rate. */
export async function lookupOngkir(kabKota: string, kecamatan: string): Promise<number> {
  if (!kabKota?.trim() || !kecamatan?.trim()) return 0
  const rows = await sql`
    SELECT final_price
    FROM jne_rates
    WHERE upper(trim(kab_kota_nama))  = upper(trim(${kabKota}))
      AND upper(trim(kecamatan_nama)) = upper(trim(${kecamatan}))
    LIMIT 1
  `
  return rows.length ? (rows[0].final_price as number) : 0
}

/**
 * Register a self-registered customer, keyed on the normalized handle (so "@User"
 * and "user" don't create duplicate rows).
 *
 * Security: this is a PUBLIC, unauthenticated path, so it must not let anyone
 * overwrite an existing customer's contact data by knowing their handle. On an
 * existing row it only **backfills empty fields** — populated whatsapp/data_diri/
 * ekspedisi/ongkir (and bank info, always) are left untouched. Established
 * customers change their details via the authenticated dashboard, not here.
 * A brand-new handle is inserted normally.
 */
export async function registerCustomer(data: {
  instagramId: string
  whatsapp: string
  dataDiri: string
  ekspedisi: string
  ongkosKirim: number
}): Promise<{ id: number; created: boolean }> {
  const norm = normalizeId(data.instagramId)
  const updated = await sql`
    UPDATE customers SET
      whatsapp     = CASE WHEN whatsapp  = '' THEN ${data.whatsapp}  ELSE whatsapp  END,
      data_diri    = CASE WHEN data_diri = '' THEN ${data.dataDiri}  ELSE data_diri END,
      ekspedisi    = CASE WHEN ekspedisi = '' THEN ${data.ekspedisi} ELSE ekspedisi END,
      ongkos_kirim = CASE WHEN ongkos_kirim = 0 AND ${data.ongkosKirim} > 0 THEN ${data.ongkosKirim} ELSE ongkos_kirim END,
      updated_at   = NOW()
    WHERE lower(replace(instagram_id, '@', '')) = ${norm}
    RETURNING id
  `
  if (updated.length) return { id: updated[0].id as number, created: false }

  const inserted = await sql`
    INSERT INTO customers (instagram_id, whatsapp, data_diri, ekspedisi, ongkos_kirim)
    VALUES (${norm}, ${data.whatsapp}, ${data.dataDiri}, ${data.ekspedisi}, ${data.ongkosKirim})
    RETURNING id
  `
  return { id: inserted[0].id as number, created: true }
}

