import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { closedStores, closeStore, reopenStore } from "@/lib/db/store-closures"

/**
 * Which shops are closed for orders on a trip, and closing or reopening one.
 *
 * Open to any role: the switch sits on the Group Order list, and whoever is
 * standing in the shop is the one who knows it has nothing left.
 */
export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const event = req.nextUrl.searchParams.get("event") ?? ""
  if (!event) return NextResponse.json({ error: "An event is required" }, { status: 400 })

  try {
    return NextResponse.json(
      { closed: await closedStores(event) },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to read store closures:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const event = String(body.event ?? "").trim()
    const store = String(body.store ?? "").trim()
    if (!event || !store) {
      return NextResponse.json({ error: "An event and a store are required" }, { status: 400 })
    }

    if (body.closed === true) await closeStore(event, store)
    else await reopenStore(event, store)

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update a store closure:", err)
    return NextResponse.json({ error: "Failed to save" }, { status: 500 })
  }
}
