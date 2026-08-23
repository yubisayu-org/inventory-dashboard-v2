import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import sql from "@/lib/db-pool"
import { normalizeCustomer } from "@/lib/db/helpers"
import { listPosts } from "@/lib/db/claims"
import { ingestImageReply, matchAmongPosts } from "@/lib/whatsapp/ingest"
import { decodable } from "@/lib/whatsapp/heic"
import { catalogueImageUrl } from "@/lib/storage"

/** How many recent shelves a forwarded photo is compared against. */
const CANDIDATES = 100

/**
 * A marked photo that arrived privately, on a shelf we work out.
 *
 * She did what everybody in the group does — circled what she wanted — and sent
 * it as a DM, where the worker never sees it and where nothing says which rack
 * it was. That last part is the hard bit when a screenshot lands in an inbox,
 * and it is already solved: the same matcher that rescues a customer who forgot
 * to reply compares the photo against recent shelves.
 *
 * Two steps on purpose. Without `confirm`, it answers which shelf it matched
 * and records nothing; with it, the claims are written. A wrong match would
 * otherwise put somebody's order on the wrong rack silently.
 */
export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const form = await req.formData()
    const file = form.get("file")
    const customer = normalizeCustomer(String(form.get("customer") ?? ""))
    const caption = String(form.get("caption") ?? "").trim()
    const confirm = String(form.get("confirm") ?? "") === "true"

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "A photo is required" }, { status: 400 })
    }
    if (!customer) {
      return NextResponse.json({ error: "A customer is required" }, { status: 400 })
    }

    const [exists] = await sql`SELECT 1 FROM customers WHERE instagram_id = ${customer}`
    if (!exists) {
      return NextResponse.json({ error: `No customer called "${customer}"` }, { status: 400 })
    }

    const dir = await mkdtemp(join(tmpdir(), "wa-dm-"))
    const scratch = join(dir, "reply.jpg")
    try {
      // HEIC included: a screenshot forwarded from an iPhone arrives in
      // whatever the phone saved it as.
      await writeFile(scratch, await decodable(Buffer.from(await file.arrayBuffer())))

      // Shelves of the trips still running. A DM about a trip that is over is
      // not an order anybody can fill.
      const { rows } = await listPosts({ page: 1, pageSize: CANDIDATES })
      const active = await sql`SELECT name FROM events WHERE is_active`
      const names = new Set(active.map((r) => r.name as string))
      const candidates = rows.filter((post) => names.has(post.event))

      const match = await matchAmongPosts(candidates, scratch)
      if (match === null) {
        return NextResponse.json(
          { error: "That photo does not match any shelf on a running trip" },
          { status: 404 },
        )
      }

      if (!confirm) {
        return NextResponse.json({
          match: {
            postId: match.post.id,
            store: match.post.store,
            event: match.post.event,
            marks: match.marks.length,
            photoUrl: match.post.viewPath ? catalogueImageUrl(match.post.viewPath) : null,
            createdAt: match.post.createdAt,
          },
        })
      }

      const { claimIds, repeats } = await ingestImageReply({
        postId: match.post.id,
        // No number: she wrote privately, and the handle is what everything
        // downstream keys on anyway.
        sender: "",
        messageId: "",
        replyPath: scratch,
        caption,
      })

      // Attributed after the resolver, which only knows about senders. Without
      // this the claims would sit in review with nobody to invoice — the state
      // this route exists to avoid.
      if (claimIds.length > 0) {
        await sql`
          UPDATE wa_claims
          SET customer = ${customer},
              state = CASE WHEN state = 'review' THEN 'pending' ELSE state END,
              updated_at = NOW()
          WHERE id = ANY(${claimIds})
        `
      }

      return NextResponse.json({
        postId: match.post.id,
        store: match.post.store,
        claims: claimIds.length,
        repeats,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  } catch (err) {
    console.error("Failed to read a marked photo from a DM:", err)
    return NextResponse.json({ error: "Failed to read that photo" }, { status: 500 })
  }
}
