import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { setSlotLabel, setSlotBought } from "@/lib/db/claims"

type Params = { params: Promise<{ id: string }> }

/**
 * The two things the shop screen writes: a working name, and how many were got.
 *
 * Open to any role on purpose. Neither creates a product, an order or a price —
 * naming does all three, and that route lives with the owner-only review page in
 * the next plan.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const id = Number((await params).id)
  try {
    const body = await req.json()

    if (typeof body.label === "string") await setSlotLabel(id, body.label)

    // Explicitly not `if (body.bought)`: zero is a real answer — "I looked and
    // there were none" — and truthiness would drop it.
    if (body.bought != null) {
      const bought = Number(body.bought)
      if (!Number.isFinite(bought) || bought < 0) {
        return NextResponse.json({ error: "bought must be zero or more" }, { status: 400 })
      }
      await setSlotBought(id, bought)
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("no such slot")) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    console.error("Failed to update slot:", err)
    return NextResponse.json({ error: "Failed to update" }, { status: 500 })
  }
}
