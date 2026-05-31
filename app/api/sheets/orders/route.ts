import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { appendOrders, withActor } from "@/lib/db"

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const rows = body.rows

    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: "rows must be a non-empty array" }, { status: 400 })
    }

    for (const row of rows) {
      if (!row.event || !row.customer || !row.productId || !row.unit) {
        return NextResponse.json({ error: "Each row requires event, customer, productId, and unit" }, { status: 400 })
      }
    }

    await withActor(session.user.email, (tx) => appendOrders(
      rows.map((r) => ({
        event: String(r.event),
        customer: String(r.customer),
        productId: Number(r.productId),
        unitPrice: Number(r.unitPrice ?? 0),
        unit: Number(r.unit),
        note: r.note ? String(r.note) : "",
      })),
      tx,
    ))

    return NextResponse.json({ success: true, count: rows.length })
  } catch (err) {
    console.error("Sheets append error:", err)
    return NextResponse.json({ error: "Failed to save orders" }, { status: 500 })
  }
}
