import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import sql from "@/lib/db-pool"
import { getCataloguePost, splitProductsByActive } from "@/lib/db/catalogue-posts"
import { createSend, attachProductToSend, listSendCodes, getLastPinPositions } from "@/lib/db/wa-sends"
import { renderCaption } from "@/lib/whatsapp/product-post"
import { queueSend } from "@/lib/db/outbox"

/**
 * One click: send a post's tagged products to a trip — no product/pin
 * review screen. Always uses the post's own title (migration 086 merged
 * "caption" and "judul" into one field the owner keeps consistent across
 * every send) and its last pin positions, if it has ever gone out before —
 * a never-sent post simply has none yet, which the loop below already
 * handles by not setting any.
 *
 * Deliberately un-reviewed, per explicit request: a discontinued product is
 * silently skipped (splitProductsByActive), not surfaced — the owner traded
 * that visibility for zero clicks. Owner or admin, same as every other send route.
 */
export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const body = await req.json().catch(() => ({}))
  const postId = Number(body.postId)
  const event = typeof body.event === "string" ? body.event : ""
  if (!Number.isInteger(postId) || postId < 1) {
    return NextResponse.json({ error: "Invalid postId" }, { status: 400 })
  }
  if (!event) {
    return NextResponse.json({ error: "event is required" }, { status: 400 })
  }

  const post = await getCataloguePost(postId)
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const title = post.title.trim()
  if (!title) {
    return NextResponse.json({ error: "This post has no title yet" }, { status: 400 })
  }

  const { activeIds } = await splitProductsByActive(post.productIds)
  if (activeIds.length === 0) {
    return NextResponse.json({ error: "No active products to send" }, { status: 400 })
  }

  try {
    const pins = await getLastPinPositions(postId)
    const send = await createSend({ postId, event, title })

    // Sequential, not Promise.all: attachProductToSend issues codes in
    // request order (see its own nextCode comment), same constraint the
    // composer's prefill loop already follows.
    for (const productId of activeIds) {
      const code = await attachProductToSend(send.id, productId)
      const pin = pins[productId]
      if (pin) {
        await sql`UPDATE wa_send_codes SET point_x = ${pin.x}, point_y = ${pin.y} WHERE id = ${code.id}`
      }
    }

    const codes = await listSendCodes(send.id)
    const caption = renderCaption({ title }, codes)
    const queued = await queueSend(send.id, event, caption)
    if (!queued) {
      return NextResponse.json(
        { error: "Tagged and ready, but this trip has no WhatsApp group bound to it" },
        { status: 400 },
      )
    }

    return NextResponse.json({ success: true, sendId: send.id })
  } catch (err) {
    console.error("Failed to quick-resend:", err)
    return NextResponse.json({ error: "Failed to send" }, { status: 500 })
  }
}
