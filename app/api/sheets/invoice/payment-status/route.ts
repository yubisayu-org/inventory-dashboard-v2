import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getPaymentStatusByEvent, getPaymentStatusAllEvents } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  // No `event` param → payment status across all events.
  const event = req.nextUrl.searchParams.get("event")?.trim()

  try {
    const rows = event ? await getPaymentStatusByEvent(event) : await getPaymentStatusAllEvents()
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to load payment status:", err)
    return NextResponse.json({ error: "Failed to load payment status" }, { status: 500 })
  }
}
