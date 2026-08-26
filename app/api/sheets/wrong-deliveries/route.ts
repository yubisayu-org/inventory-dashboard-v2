import { NextRequest, NextResponse } from "next/server"
import { getWrongDeliveries } from "@/lib/db"
import { requireSession, requireRole } from "@/lib/api"

/**
 * What arrived instead, per item, on one trip.
 *
 * Read by the refund composer so a wrong-delivery notice can name the
 * substitute the Arrival List already recorded, rather than leaving whoever
 * writes it to remember.
 */
export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const event = req.nextUrl.searchParams.get("event")?.trim() ?? ""
  if (!event) return NextResponse.json({ error: "event is required" }, { status: 400 })

  try {
    return NextResponse.json(
      { received: await getWrongDeliveries(event) },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to load wrong deliveries:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}
