import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { lookupOngkir } from "./customers"
import { composeLabel, canCompose } from "../address"

// The profile a signed-in customer may see and edit on the catalogue site.
//
// Contact and address only. Bank details and ongkos_kirim are deliberately
// absent from the shape, not merely unselected — a field that does not exist
// cannot be leaked by a later careless spread.

export type CustomerProfile = {
  instagramId: string
  name: string
  whatsapp: string
  /** Her street, and the field the label is built from. */
  jalan: string
  provinsi: string
  /** Generated from the parts beside it — see updateCustomerProfile. Returned
   *  so the caller can show what the label says, never so it can be typed. */
  dataDiri: string
  kota: string
  kecamatan: string
  kodePos: string
  biteshipAreaId: string | null
  biteshipAreaName: string | null
}

/**
 * Two shapes, for the two callers that exist while the catalogue catches up.
 *
 * A caller that sends `jalan` gets the current behaviour: the street is stored
 * and the label is composed from the parts, as the staff form does.
 *
 * A caller that sends only `dataDiri` is the catalogue as it stands today,
 * which has no separate street to send. Its string is written verbatim and
 * `jalan` is left alone — exactly what this function did before. It must NOT
 * be treated as a street: what that caller sends is the whole composed label,
 * and storing it as one would put a label inside a label.
 */
export type CustomerProfileInput = {
  name: string
  whatsapp: string
  jalan?: string
  provinsi?: string
  /** Legacy path only. Ignored whenever `jalan` is given. */
  dataDiri?: string
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
      jalan: string
      provinsi: string
      data_diri: string
      kota: string
      kecamatan: string
      kode_pos: string
      biteship_area_id: string | null
      biteship_area_name: string | null
    }[]
  >`
    SELECT instagram_id, name, whatsapp, jalan, provinsi, data_diri,
           kota, kecamatan, kode_pos,
           biteship_area_id, biteship_area_name
      FROM customers WHERE id = ${customerId}
  `
  if (!row) return null
  return {
    instagramId: row.instagram_id,
    name: row.name,
    whatsapp: row.whatsapp,
    jalan: row.jalan,
    provinsi: row.provinsi,
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
 *
 * data_diri is COMPOSED here, exactly as lib/db/customers.ts composes it for
 * the staff form. This path used to write whatever the caller sent and never
 * wrote jalan at all — so a customer who moved house updated her city and
 * district while her street stayed where it was, her label kept the old one,
 * and the next save that regenerated the string from the parts undid her edit
 * entirely. The parts are the truth; the string is made from them.
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
  // Flagged if ANY warehouse could not be priced, not only if all of them
  // failed. A warehouse with no rate for the new address keeps the rate for
  // the OLD one — a customer who moves from Bandung to Papua would go on being
  // charged the Bandung rate, silently, and that figure feeds invoice_total.
  // Never written as 0 either, because 0 is free shipping.
  const needsReview = priceable.length < resolved.length

  // Composed only from a real street. Without one there is nothing to build a
  // better label out of, so the stored string stands: a customer whose street
  // was never recorded separately keeps a hand-written label that works rather
  // than getting a generated one with a hole where the street should be.
  const parts = {
    name: input.name,
    whatsapp: input.whatsapp,
    jalan: input.jalan ?? "",
    kecamatan: input.kecamatan,
    kota: input.kota,
    provinsi: input.provinsi ?? "",
    kodePos: input.kodePos,
    areaName: input.biteshipAreaName ?? "",
  }
  // The legacy string is the fallback, never the street. See the input type.
  const dataDiri = canCompose(parts) ? composeLabel(parts) : (input.dataDiri || null)

  await sql.begin(async (tx) => {
    // COALESCE on the two new columns so the legacy caller, which knows
    // nothing about them, leaves them as they are instead of blanking them.
    await tx`
      UPDATE customers SET
        name                = ${input.name},
        whatsapp            = ${input.whatsapp},
        jalan               = COALESCE(${input.jalan ?? null}, jalan),
        provinsi            = COALESCE(${input.provinsi ?? null}, provinsi),
        data_diri           = COALESCE(${dataDiri}, data_diri),
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
