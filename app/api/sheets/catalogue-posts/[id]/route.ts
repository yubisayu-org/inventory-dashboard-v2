import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { setCataloguePostVisible, setCataloguePostHighlight, getCataloguePost } from "@/lib/db"

type Params = { params: Promise<{ id: string }> }

/** One post, including its tagged `productIds` — the composer's "Pakai post
 *  lama" pre-fill reads this to learn which products a past post carried,
 *  so it can re-attach each to the new send in order. Owner-only, matching
 *  every other route this composer talks to. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  const post = await getCataloguePost(id)
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ post }, { headers: { "Cache-Control": "no-store" } })
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    const body = await req.json()
    if (body.visible === undefined && body.highlightId === undefined) {
      return NextResponse.json({ error: "visible or highlightId is required" }, { status: 400 })
    }
    if (body.visible !== undefined) {
      if (typeof body.visible !== "boolean") {
        return NextResponse.json({ error: "visible must be a boolean" }, { status: 400 })
      }
      await setCataloguePostVisible(id, body.visible)
    }
    if (body.highlightId !== undefined) {
      if (body.highlightId !== null && (!Number.isInteger(body.highlightId) || body.highlightId < 1)) {
        return NextResponse.json({ error: "highlightId must be a positive integer or null" }, { status: 400 })
      }
      await setCataloguePostHighlight(id, body.highlightId)
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update catalogue post:", err)
    return NextResponse.json({ error: "Failed to update post" }, { status: 500 })
  }
}
