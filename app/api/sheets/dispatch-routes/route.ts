import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole, requireOwner } from "@/lib/api"
import { getDispatchRoutes, saveDispatchRoutes, withActor } from "@/lib/db"

/**
 * The shipping routes and their codes.
 *
 * Readable by any role: the receiving list needs them to file a parcel, and
 * that screen is worked by whoever is at the bench.
 */
export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    return NextResponse.json({ routes: await getDispatchRoutes() },
      { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to load dispatch routes:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

/**
 * Owner-only: a prefix decides which tab every parcel files under, and the day
 * counts decide which boxes look late.
 */
export async function PUT(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const body = await req.json()
    if (!Array.isArray(body.routes)) {
      return NextResponse.json({ error: "routes are required" }, { status: 400 })
    }
    await withActor(session.user?.email ?? null, (tx) => saveDispatchRoutes(body.routes, tx))
    return NextResponse.json({ success: true, routes: await getDispatchRoutes() })
  } catch (err) {
    // The data layer's messages name the offending route and say what is wrong
    // with it, so they are worth showing rather than replacing.
    const message = err instanceof Error ? err.message : "Failed to save"
    console.error("Failed to save dispatch routes:", err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
