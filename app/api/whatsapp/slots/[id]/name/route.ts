import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { nameSlot } from "@/lib/whatsapp/naming"

type Params = { params: Promise<{ id: string }> }

/**
 * Turn a counted slot into a product and its orders.
 *
 * Open to any role. Naming is the bulk of the work on this screen and an admin
 * does it beside the owner; what stays owner-only is the tally, because the
 * count is the figure the accounts are reconciled against.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const id = Number((await params).id)
  try {
    const body = await req.json()
    if (!String(body.name ?? "").trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 })
    }

    const result = await nameSlot({
      slotId: id,
      name: String(body.name),
      valas: Number(body.valas) || 0,
      gram: Number(body.gram) || 0,
      price: body.price != null ? Number(body.price) : undefined,
      // Explicitly false only: an older client that says nothing still gets the
      // orders it has always got.
      withOrders: body.withOrders !== false,
    })
    return NextResponse.json(result)
  } catch (err) {
    // nameSlot refuses rather than guessing — already named, an unresolved
    // customer, no country, a Target Price post with no price. Every one of
    // those is the caller's to fix, so it is a 400 carrying the reason rather
    // than a 500 that hides it.
    if (
      err instanceof Error &&
      /already named|unresolved customer|no country|needs a price|no such slot/.test(err.message)
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    console.error("Failed to name slot:", err)
    return NextResponse.json({ error: "Failed to name" }, { status: 500 })
  }
}
