import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import sql from "@/lib/db-pool"
import { previewRedirect } from "@/lib/db/redirect-ongkir"

// What a redirect to this area would cost, for staff writing one down on her
// behalf. The same question her own sheet asks, answered the same way, so the
// figure she was quoted and the figure staff see cannot differ.
//
// Read-only. Saving the address is what prices and charges it.

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const customer = String(body.customer ?? "").trim()
    const event = String(body.event ?? "").trim()
    const areaId = String(body.areaId ?? "").trim()
    if (!customer || !event || !areaId) {
      return NextResponse.json({ error: "customer, event and areaId are required" }, { status: 400 })
    }

    const [row] = (await sql`
      SELECT id FROM customers
       WHERE lower(replace(instagram_id, '@', '')) = lower(replace(${customer}, '@', ''))
    `) as unknown as { id: number }[]
    if (!row) return NextResponse.json({ error: "Unknown customer" }, { status: 404 })

    return NextResponse.json({ quote: await previewRedirect(row.id, event, areaId) })
  } catch (err) {
    console.error("Failed to quote a redirect:", err)
    return NextResponse.json({ error: "Failed to quote" }, { status: 500 })
  }
}
