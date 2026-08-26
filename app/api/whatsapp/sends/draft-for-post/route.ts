import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import sql from "@/lib/db-pool"
import { getCataloguePost } from "@/lib/db/catalogue-posts"
import { createSend } from "@/lib/db/wa-sends"

/**
 * A draft send to edit an existing post's tags/pins in — reuses the most
 * recent unsent draft for this post AND this event if one already exists
 * (e.g. from a past "Simpan & tutup"), rather than piling up a fresh one
 * every time the edit modal opens. Scoped to the event too, not just the
 * post: a draft abandoned under a different trip must not get silently
 * reused when editing for this one — codes are minted per-event, so
 * mixing them would be wrong, not just surprising. `isNew` tells the
 * caller whether to prefill from the post's current tags (a brand-new
 * draft has none yet) or leave an existing draft's codes alone (it's
 * already carrying whatever was saved last time).
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

  // Everything below talks to the database, and until this was wrapped an
  // error escaped the handler: Next answers an unhandled throw with a 500 and
  // NO BODY, so the caller's res.json() failed with "Unexpected end of JSON
  // input" and the real fault was never seen. Every sibling route wraps; this
  // one did not.
  try {
    const post = await getCataloguePost(postId)
    if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 })

    // An empty draft (nothing ever tagged onto it) is useless to resume —
    // reusing one would show up as "the tagged product is not there" for a
    // post that clearly has tags, since isNew=false skips the prefill that
    // would otherwise re-attach them. Requiring at least one code means a
    // draft abandoned before anything was tagged is simply skipped in favor
    // of a fresh one, never resurfaced as a false "existing draft".
    const [existing] = await sql`
      SELECT s.id FROM wa_sends s
      WHERE s.post_id = ${postId} AND s.event = ${event} AND s.message_id = ''
        AND EXISTS (SELECT 1 FROM wa_send_codes c WHERE c.send_id = s.id)
      ORDER BY s.id DESC LIMIT 1
    `
    if (existing) {
      return NextResponse.json({ sendId: existing.id as number, isNew: false })
    }

    const send = await createSend({ postId, event, title: post.title })
    return NextResponse.json({ sendId: send.id, isNew: true })
  } catch (err) {
    console.error("Failed to open a draft for post:", err)
    return NextResponse.json({ error: "Could not open the editor for this post" }, { status: 500 })
  }
}
