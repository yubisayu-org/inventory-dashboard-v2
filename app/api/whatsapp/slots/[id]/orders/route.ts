import { NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { addMissingOrders } from "@/lib/whatsapp/naming"

type Params = { params: Promise<{ id: string }> }

/**
 * Give the claims that arrived after naming their orders.
 *
 * Owner-only, like naming itself: this puts lines on an invoice.
 */
export async function POST(_req: Request, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const id = Number((await params).id)
  try {
    return NextResponse.json(await addMissingOrders(id))
  } catch (err) {
    const message = (err as Error).message
    if (/no such slot|not been named|no longer exists/.test(message)) {
      return NextResponse.json({ error: message }, { status: 400 })
    }
    console.error("Failed to add missing orders:", err)
    return NextResponse.json({ error: "Failed to add orders" }, { status: 500 })
  }
}
