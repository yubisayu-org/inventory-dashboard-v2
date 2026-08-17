import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole, requireOwner } from "@/lib/api"
import sql from "@/lib/db-pool"
import { toPricingMethod } from "@/lib/pricing"
import { getPost, listSlots, listClaims } from "@/lib/db/claims"

type Params = { params: Promise<{ id: string }> }

/**
 * Everything one post knows.
 *
 * Open to any role: the shop screen reads this, and counting what is on a shelf
 * is not the same act as naming it. The write routes are where the two roles
 * part company.
 */
export async function GET(_req: Request, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const id = Number((await params).id)
  try {
    const post = await getPost(id)
    if (post === null) return NextResponse.json({ error: "Not found" }, { status: 404 })

    const [slots, claims] = await Promise.all([listSlots(id), listClaims(id)])
    return NextResponse.json({ post, slots, claims }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to load WhatsApp post:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

/**
 * Correct what a post was captured with.
 *
 * A post snapshots the store and pricing method at capture time, and changing
 * the global default afterwards deliberately does not reach back — a setting
 * edited in the evening must not silently reprice a morning's shelves. But a
 * shelf captured under the wrong method cannot be re-posted either, so it has
 * to be correctable here.
 *
 * Owner-only: this decides what every SKU on the shelf will cost.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const id = Number((await params).id)
  try {
    const post = await getPost(id)
    if (post === null) return NextResponse.json({ error: "Not found" }, { status: 404 })

    const body = await req.json()

    if (typeof body.pricingMethod === "string") {
      await sql`
        UPDATE wa_posts SET pricing_method = ${toPricingMethod(body.pricingMethod)},
                            updated_at = NOW()
        WHERE id = ${id}
      `
    }
    if (typeof body.store === "string") {
      await sql`UPDATE wa_posts SET store = ${body.store.trim()}, updated_at = NOW() WHERE id = ${id}`
    }

    // Named SKUs keep the price they were created with, because their products
    // and orders already exist and repricing them here would change what
    // customers have been quoted.
    const [named] = await sql`
      SELECT COUNT(*)::int AS n FROM wa_slots WHERE post_id = ${id} AND product_id IS NOT NULL
    `
    return NextResponse.json({ success: true, alreadyNamed: named.n as number })
  } catch (err) {
    console.error("Failed to update post:", err)
    return NextResponse.json({ error: "Failed to update" }, { status: 500 })
  }
}
