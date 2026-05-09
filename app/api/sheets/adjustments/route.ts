import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getAdjustmentRows, addAdjustment } from "@/lib/db"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const rows = await getAdjustmentRows()
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch adjustments:", err)
    return NextResponse.json({ error: "Failed to fetch adjustments" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const { event, customer, description, amount } = body

    if (!event || !customer) {
      return NextResponse.json({ error: "event and customer are required" }, { status: 400 })
    }

    const result = await addAdjustment({
      event: String(event),
      customer: String(customer),
      description: String(description ?? ""),
      amount: Number(amount ?? 0),
    })

    return NextResponse.json({ success: true, rowNumber: result.rowNumber })
  } catch (err) {
    console.error("Failed to add adjustment:", err)
    return NextResponse.json({ error: "Failed to add adjustment" }, { status: 500 })
  }
}
