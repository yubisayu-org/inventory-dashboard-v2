import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getWarehouses, lookupOngkir } from "@/lib/db"

/**
 * What her shipping would cost from each warehouse, if this address were saved.
 *
 * Shown before the save, never applied by it. A rate can be a deliberate
 * discount somebody granted, and correcting a typo in her city is not consent
 * to withdraw it -- so the screen prints "11.000 -> 18.000" and a person ticks
 * it. The catalogue re-prices silently because the customer is editing her own
 * address; here somebody is editing hers.
 *
 * `rate: 0` means the rates table has nothing for that district, which is not
 * free shipping. The screen leaves those alone.
 */
export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const body = await req.json().catch(() => ({}))
  const kota = String(body.kota ?? "").trim()
  const kecamatan = String(body.kecamatan ?? "").trim()
  if (!kota || !kecamatan) {
    return NextResponse.json({ rates: [] })
  }

  const warehouses = await getWarehouses()
  const rates = await Promise.all(
    warehouses.map(async (w) => ({
      warehouseId: w.id,
      code: w.code,
      rate: await lookupOngkir(w.code, kota, kecamatan),
    })),
  )
  return NextResponse.json({ rates })
}
