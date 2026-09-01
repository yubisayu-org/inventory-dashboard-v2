import sql from "../db-pool"
import { courierRates, BiteshipNotConfiguredError } from "../biteship"

/**
 * What a one-kilo parcel costs from an origin to an area, or null. Injectable
 * so the tests can pin the free path without a suite that bills the courier
 * every time somebody runs it.
 */
export type RateFetcher = (originAreaId: string, areaId: string) => Promise<number | null>

const askTheCourier: RateFetcher = async (originAreaId, areaId) => {
  // A one-kilo parcel, because our own rates are per kilo -- anything else
  // compares a rate against a total.
  const rates = await courierRates(originAreaId, areaId, 1000)
  const reg = rates.find((r) => /^(reg|ctc)$/i.test(r.serviceCode)) ?? rates[0]
  return reg?.price ?? null
}

/**
 * Re-price a customer the moment her area changes.
 *
 * A stored quote belongs to the area it was bought for, so changing the area
 * drops it -- that rule exists because seven corrected customers went on being
 * priced to the towns they had left, `iinkaila` carrying Medan's Rp 47.000 to
 * Pondok Aren. Dropping it is right. Leaving her with nothing afterwards is
 * what this fixes: 28 customers have a quote sitting on a stored rate of zero,
 * and for them "no quote" means the next parcel ships free until somebody
 * notices.
 *
 * It matters more now that the four address fields are read-only for staff. The
 * only way to correct an address is to pick an area, so the path that drops a
 * quote is the path everybody takes.
 *
 * Asking Biteship is billed, so it is the last resort, not the first move. A
 * quote belongs to an AREA, not a person: two customers in one area must carry
 * the same figure -- the invariant that caught every stale rate in the August
 * sweep. So a neighbour's stored quote answers for free, and only an area
 * nobody has ever quoted costs a request.
 *
 * Never throws. A failed quote leaves the row NULL, which is exactly where the
 * old behaviour left it -- and the "No rate" filter and the ship-screen warning
 * are what catch that. Re-pricing must not be able to fail a save.
 */
export async function requoteCustomerArea(
  customerId: number,
  areaId: string,
  fetchRate: RateFetcher = askTheCourier,
): Promise<{ warehouseId: number; price: number; asked: boolean }[]> {
  if (!areaId.trim()) return []

  const warehouses = (await sql`
    SELECT id, biteship_area_id AS origin FROM warehouses
     WHERE COALESCE(biteship_area_id, '') <> ''
  `) as unknown as { id: number; origin: string }[]
  if (warehouses.length === 0) return []

  // What this area is already known to cost, per warehouse. One stored row
  // answers for every customer in the area, so most corrections cost nothing.
  const knownRows = (await sql`
    SELECT cwo.warehouse_id, max(cwo.biteship_ongkir)::int AS price
      FROM customers c
      JOIN customer_warehouse_ongkir cwo ON cwo.customer_id = c.id
     WHERE c.biteship_area_id = ${areaId}
       AND c.id <> ${customerId}
       AND cwo.biteship_ongkir IS NOT NULL
     GROUP BY cwo.warehouse_id
  `) as unknown as { warehouse_id: number; price: number }[]
  const known = new Map(knownRows.map((r) => [r.warehouse_id, r.price]))

  const applied: { warehouseId: number; price: number; asked: boolean }[] = []

  for (const w of warehouses) {
    let price = known.get(w.id) ?? null
    let asked = false

    if (price == null) {
      asked = true
      try {
        price = await fetchRate(w.origin, areaId)
      } catch (err) {
        // No key configured, a timeout, a 500 at the courier: all the same
        // answer here. She keeps no quote and the guard picks her up.
        if (!(err instanceof BiteshipNotConfiguredError)) {
          console.error("Re-quote failed for", areaId, err)
        }
        price = null
      }
    }

    if (price == null || price <= 0) continue

    await sql`
      UPDATE customer_warehouse_ongkir
         SET biteship_ongkir = ${price}, biteship_quoted_at = NOW(), updated_at = NOW()
       WHERE customer_id = ${customerId} AND warehouse_id = ${w.id}
    `
    applied.push({ warehouseId: w.id, price, asked })
  }

  return applied
}
