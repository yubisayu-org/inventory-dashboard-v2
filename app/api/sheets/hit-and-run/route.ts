import { NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getHitAndRun } from "@/lib/db"
import { cached } from "@/lib/route-cache"

/**
 * Who has walked away from an order.
 *
 * One request per page rather than one per row: the pages that show this show
 * it beside many customers at once, and asking per row would turn a single
 * cheap scan into dozens. Cached for a minute on top of that -- the answer only
 * changes when somebody cancels a whole order.
 */
export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const rows = await cached("hit-and-run", getHitAndRun)
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch hit-and-run marks:", err)
    return NextResponse.json({ error: "Failed to fetch marks" }, { status: 500 })
  }
}
