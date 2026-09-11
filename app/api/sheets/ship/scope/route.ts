import { NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import sql from "@/lib/db-pool"

/**
 * Which trip the packing screen should open on.
 *
 * Not the newest one. Goods arrive months after a trip is opened, so the trip
 * with parcels waiting to go out is usually an older one -- on 11 Sep 2026 the
 * newest active trip had nothing ready and 114 parcels were waiting on
 * LSJP202608. Opening on the newest meant opening on an empty page while the
 * dashboard said 127 were ready.
 *
 * One aggregate row rather than the packing query itself: units that have
 * arrived and not gone out is a good enough aim for a default, and the tab
 * badges tell the exact truth once the trip is chosen.
 */
export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const [row] = (await sql`
      SELECT event,
             SUM(GREATEST(0, COALESCE(unit_arrive, 0)
                   - COALESCE(unit_ship, 0) - COALESCE(unit_hold, 0)))::int AS waiting
        FROM orders
       GROUP BY event
      HAVING SUM(GREATEST(0, COALESCE(unit_arrive, 0)
                  - COALESCE(unit_ship, 0) - COALESCE(unit_hold, 0))) > 0
       ORDER BY waiting DESC
       LIMIT 1
    `) as unknown as { event: string; waiting: number }[]

    return NextResponse.json({ event: row?.event ?? "" }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to pick the packing trip:", err)
    // The screen falls back to its own choice rather than failing to open.
    return NextResponse.json({ event: "" })
  }
}
