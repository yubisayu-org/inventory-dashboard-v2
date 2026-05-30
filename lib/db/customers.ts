import sql from "../db-pool"
import { normalizeId } from "./helpers"
import type { CustomerDetail, CustomerRow, CustomerInput } from "./types"

// ─── Customers ──────────────────────────────────────────────────────────────

export async function lookupCustomerDetail(instagramId: string): Promise<CustomerDetail | null> {
  const searchId = normalizeId(instagramId)
  const rows = await sql`
    SELECT name, whatsapp, data_diri, ekspedisi, ongkos_kirim,
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
    SELECT id, instagram_id, name, whatsapp, data_diri, ekspedisi, ongkos_kirim,
           bank_name, bank_account_number, bank_account_holder,
           created_at, updated_at
    FROM customers
    ORDER BY instagram_id ASC
  `
  return rows.map((r) => ({
    id: r.id as number,
    instagramId: r.instagram_id ?? "",
    name: r.name ?? "",
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
  // Canonical form is bare lowercase, no '@'. Without this, "@User" and "user"
  // would each create their own row and the order flow (which normalizes the
  // handle on insert) would attach orders to a different row than the one the
  // admin filled out.
  const instagramId = normalizeId(data.instagramId)
  const rows = await sql`
    INSERT INTO customers (
      instagram_id, name, whatsapp, data_diri, ekspedisi, ongkos_kirim,
      bank_name, bank_account_number, bank_account_holder
    ) VALUES (
      ${instagramId}, ${data.name}, ${data.whatsapp}, ${data.dataDiri}, ${data.ekspedisi}, ${data.ongkosKirim},
      ${data.bankName}, ${data.bankAccountNumber}, ${data.bankAccountHolder}
    )
    RETURNING id
  `
  return { id: rows[0].id as number }
}

export async function updateCustomer(id: number, data: CustomerInput): Promise<void> {
  const instagramId = normalizeId(data.instagramId)
  await sql`
    UPDATE customers
    SET instagram_id        = ${instagramId},
        name                = ${data.name},
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
 * Re-submission is expected behavior — the form tells users to re-register when
 * their address changes — so an existing row's contact fields (name/whatsapp/
 * data_diri/ekspedisi/ongkos_kirim) are overwritten with the latest submission.
 * Bank info is never touched here; that lives behind the authenticated dashboard.
 */
export async function registerCustomer(data: {
  instagramId: string
  name: string
  whatsapp: string
  dataDiri: string
  ekspedisi: string
  ongkosKirim: number
}): Promise<{ id: number; created: boolean }> {
  const norm = normalizeId(data.instagramId)
  const updated = await sql`
    UPDATE customers SET
      name         = ${data.name},
      whatsapp     = ${data.whatsapp},
      data_diri    = ${data.dataDiri},
      ekspedisi    = ${data.ekspedisi},
      ongkos_kirim = ${data.ongkosKirim},
      updated_at   = NOW()
    WHERE lower(replace(instagram_id, '@', '')) = ${norm}
    RETURNING id
  `
  if (updated.length) return { id: updated[0].id as number, created: false }

  const inserted = await sql`
    INSERT INTO customers (instagram_id, name, whatsapp, data_diri, ekspedisi, ongkos_kirim)
    VALUES (${norm}, ${data.name}, ${data.whatsapp}, ${data.dataDiri}, ${data.ekspedisi}, ${data.ongkosKirim})
    RETURNING id
  `
  return { id: inserted[0].id as number, created: true }
}

