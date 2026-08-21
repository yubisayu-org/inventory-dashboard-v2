import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { setCataloguePostVisible, setCataloguePostHighlight, setCataloguePostTitle, getCataloguePost } from "@/lib/db"
import { splitProductsByActive, setCataloguePostProducts, deleteCataloguePost } from "@/lib/db/catalogue-posts"
import { getLastPinPositions } from "@/lib/db/wa-sends"
import { deleteCatalogueMedia } from "@/lib/storage"

type Params = { params: Promise<{ id: string }> }

/** One post, including its tagged `productIds`, which of those are still
 *  sellable (`activeProductIds`) vs. delisted since (`removedProducts`,
 *  named so the composer can say so rather than silently re-advertising or
 *  silently dropping one), and each still-sellable product's last placed
 *  pin position (`pins`, keyed by product id). The composer's "Pakai post
 *  lama" pre-fill reads all three to re-attach a past post's products to
 *  the new send and carry each pin forward. Owner or admin, matching every
 *  other route this composer talks to. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  const post = await getCataloguePost(id)
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const [{ activeIds: activeProductIds, removed: removedProducts }, pins] = await Promise.all([
    splitProductsByActive(post.productIds),
    getLastPinPositions(id),
  ])
  return NextResponse.json(
    { post, activeProductIds, removedProducts, pins },
    { headers: { "Cache-Control": "no-store" } },
  )
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    const body = await req.json()
    if (
      body.visible === undefined && body.highlightId === undefined &&
      body.title === undefined && body.productIds === undefined
    ) {
      return NextResponse.json({ error: "visible, highlightId, title, or productIds is required" }, { status: 400 })
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
    if (body.title !== undefined) {
      if (typeof body.title !== "string") {
        return NextResponse.json({ error: "title must be a string" }, { status: 400 })
      }
      await setCataloguePostTitle(id, body.title.trim())
    }
    if (body.productIds !== undefined) {
      if (!Array.isArray(body.productIds) || !body.productIds.every((n: unknown) => Number.isInteger(n))) {
        return NextResponse.json({ error: "productIds must be an array of integers" }, { status: 400 })
      }
      await setCataloguePostProducts(id, body.productIds)
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update catalogue post:", err)
    return NextResponse.json({ error: "Failed to update post" }, { status: 500 })
  }
}

/** Delete a post entirely — see deleteCataloguePost's own doc for what
 *  happens to sends that already went out (detached, not destroyed) vs.
 *  drafts that never did (hard-deleted, freeing their codes). Owner or admin,
 *  matching every other route in this family. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    const result = await deleteCataloguePost(id)
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 })
    await deleteCatalogueMedia(result.mediaUrl)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to delete catalogue post:", err)
    return NextResponse.json({ error: "Failed to delete post" }, { status: 500 })
  }
}
