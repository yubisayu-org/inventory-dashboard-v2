import { NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
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
