import { NextRequest, NextResponse } from "next/server"
import { duplicateProductAsVariant, withActor } from "@/lib/db"
import { requireSession, requireRole } from "@/lib/api"

/**
 * Copy a product under a new name, for a variant of something already ordered.
 *
 * Staff may do this; creating a product from scratch stays the owner's. The
 * difference is what has to be sent: a new product means naming a store, a
 * cost and a margin, and this only names an existing product and what to call
 * the copy. The commercial fields are read and written server-side and never
 * cross the wire, so the caller neither sees the pricing nor gets to set it.
 */
export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  // Named outside the try so the catch can say which name clashed.
  let attempted = ""
  try {
    const body = await req.json()
    const fromProductId = Number(body.fromProductId)
    const name = String(body.name ?? "").trim()
    attempted = name
    if (!Number.isInteger(fromProductId) || fromProductId < 1) {
      return NextResponse.json({ error: "fromProductId is required" }, { status: 400 })
    }
    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 })

    const created = await withActor(session.user.email, (tx) =>
      duplicateProductAsVariant(fromProductId, name, tx))
    return NextResponse.json({ success: true, ...created })
  } catch (err) {
    // A name already taken is the everyday case here — the same variant gets
    // added twice — so it is answered rather than swallowed into a 500.
    const message = err instanceof Error ? err.message : "Failed to create variant"
    const taken = /duplicate key|unique/i.test(message)
    console.error("Failed to duplicate product as variant:", err)
    return NextResponse.json(
      { error: taken ? `A product called “${attempted}” already exists` : message },
      { status: taken ? 409 : 500 },
    )
  }
}
