import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { lookupOngkir } from "./customers"

// The profile a signed-in customer may see and edit on the catalogue site.
//
// Contact and address only. Bank details and ongkos_kirim are deliberately
// absent from the shape, not merely unselected — a field that does not exist
// cannot be leaked by a later careless spread.

export type CustomerProfile = {
  instagramId: string
  name: string
  whatsapp: string
  dataDiri: string
  kota: string
  kecamatan: string
  kodePos: string
  biteshipAreaId: string | null
  biteshipAreaName: string | null
}

export type CustomerProfileInput = {
  name: string
  whatsapp: string
  dataDiri: string
  kota: string
  kecamatan: string
  kodePos: string
  biteshipAreaId: string | null
  biteshipAreaName: string | null
}

/**
 * Read a customer's own profile.
 *
 * The db parameter exists so the public request path can pass the
 * catalogue_public connection: that role can see these columns and cannot see
 * bank details or ongkos_kirim at all, which keeps a query bug on this path
 * from reaching them.
 */
export async function getCustomerProfile(
  customerId: number,
  db: DBExecutor = sql,
): Promise<CustomerProfile | null> {
  const [row] = await db<
    {
      instagram_id: string
      name: string
      whatsapp: string
      data_diri: string
      kota: string
      kecamatan: string
      kode_pos: string
      biteship_area_id: string | null
      biteship_area_name: string | null
    }[]
  >`
    SELECT instagram_id, name, whatsapp, data_diri, kota, kecamatan, kode_pos,
           biteship_area_id, biteship_area_name
      FROM customers WHERE id = ${customerId}
  `
  if (!row) return null
  return {
    instagramId: row.instagram_id,
    name: row.name,
    whatsapp: row.whatsapp,
    dataDiri: row.data_diri,
    kota: row.kota,
    kecamatan: row.kecamatan,
    kodePos: row.kode_pos,
    biteshipAreaId: row.biteship_area_id,
    biteshipAreaName: row.biteship_area_name,
  }
}

/**
 * Save a customer's own contact and address, and re-price their shipping.
 *
 * Runs on the main pool: catalogue_public has no UPDATE on customers by
 * design, and this also writes customer_warehouse_ongkir. The caller is
 * responsible for having verified the session — customerId must never come
 * from a request body.
 *
 * Re-pricing follows the rule that a move must not silently become free
 * shipping: a destination that matches no rate leaves the previous ongkir
 * untouched and raises ongkir_needs_review instead of writing 0.
 */
export async function updateCustomerProfile(
  customerId: number,
  input: CustomerProfileInput,
): Promise<{ needsReview: boolean }> {
  const warehouses = await sql<{ id: number; code: string }[]>`
    SELECT id, code FROM warehouses
  `

  // Resolved before the transaction: each lookup is its own query, and holding
  // a transaction open across all of them buys nothing.
  const resolved = await Promise.all(
    warehouses.map(async (w) => ({
      warehouseId: w.id,
      rate: await lookupOngkir(w.code, input.kota, input.kecamatan),
    })),
  )
  const priceable = resolved.filter((r) => r.rate > 0)
  // Unpriceable only if NOTHING matched. One warehouse out of several failing
  // is a gap in that origin's rate set, not a bad address.
  const needsReview = priceable.length === 0

  await sql.begin(async (tx) => {
    await tx`
      UPDATE customers SET
        name                = ${input.name},
        whatsapp            = ${input.whatsapp},
        data_diri           = ${input.dataDiri},
        kota                = ${input.kota},
        kecamatan           = ${input.kecamatan},
        kode_pos            = ${input.kodePos},
        biteship_area_id    = ${input.biteshipAreaId},
        biteship_area_name  = ${input.biteshipAreaName},
        ongkir_needs_review = ${needsReview},
        updated_at          = NOW()
      WHERE id = ${customerId}
    `
    for (const r of priceable) {
      await tx`
        INSERT INTO customer_warehouse_ongkir (customer_id, warehouse_id, ongkos_kirim, updated_at)
        VALUES (${customerId}, ${r.warehouseId}, ${r.rate}, NOW())
        ON CONFLICT (customer_id, warehouse_id)
        DO UPDATE SET ongkos_kirim = EXCLUDED.ongkos_kirim, updated_at = NOW()
      `
    }
  })

  return { needsReview }
}
