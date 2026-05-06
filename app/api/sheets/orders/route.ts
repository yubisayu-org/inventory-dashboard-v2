import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { appendOrders } from "@/lib/db"

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
      if (!row.event || !row.customer || !row.items || !row.unit) {
        return NextResponse.json({ error: "Each row requires event, customer, items, and unit" }, { status: 400 })
      }
    }

    await appendOrders(
      rows.map((r) => ({
        event: String(r.event),
        customer: String(r.customer),
        items: String(r.items),
        unit: Number(r.unit),
        note: r.note ? String(r.note) : "",
      })),
    )

    return NextResponse.json({ success: true, count: rows.length })
  } catch (err) {
    console.error("Sheets append error:", err)
    return NextResponse.json({ error: "Failed to save orders" }, { status: 500 })
  }
}
