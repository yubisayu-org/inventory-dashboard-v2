import { NextRequest, NextResponse } from "next/server"
import sql from "@/lib/db-pool"
import { requireSession, requireRole } from "@/lib/api"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? ""
  if (q.length < 2) return NextResponse.json({ products: [] })

  const rows = await sql`
    SELECT id, name, store, price
    FROM products
    WHERE is_active AND (name ILIKE ${"%" + q + "%"} OR store ILIKE ${"%" + q + "%"})
    ORDER BY name
    LIMIT 20
  `
  return NextResponse.json(
    {
      products: rows.map((r) => ({ id: r.id, name: r.name, store: r.store, price: Number(r.price) })),
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}
