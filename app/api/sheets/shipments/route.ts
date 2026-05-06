import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getShippingRecords, updateTrackingNumber } from "@/lib/db"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const data = await getShippingRecords()
    return NextResponse.json(data)
  } catch (err) {
    console.error("Failed to load shipments:", err)
    return NextResponse.json({ error: "Failed to load shipments" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const { rowNumber, trackingNumber } = await req.json()
    if (!rowNumber || typeof trackingNumber !== "string") {
      return NextResponse.json({ error: "rowNumber and trackingNumber are required" }, { status: 400 })
    }
    await updateTrackingNumber(rowNumber, trackingNumber)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("Failed to update tracking number:", err)
    return NextResponse.json({ error: "Failed to update" }, { status: 500 })
  }
}
