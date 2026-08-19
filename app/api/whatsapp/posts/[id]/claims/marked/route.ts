import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import sql from "@/lib/db-pool"
import { normalizeCustomer } from "@/lib/db/helpers"
import { getPost } from "@/lib/db/claims"
import { ingestImageReply } from "@/lib/whatsapp/ingest"
import { decodable } from "@/lib/whatsapp/heic"

type Params = { params: Promise<{ id: string }> }

/**
 * A marked photo a customer sent privately.
 *
 * She did the same thing everybody in the group does — circled what she wanted
 * — but sent it as a DM, where the worker never sees it. The picture is read by
 * exactly the same resolver: difference detection first, hue second, crop
 * matching last, one claim per mark, size and quantity from the caption.
 *
 * The only thing supplied by hand is who she is, because a private message
 * carries no group identity the bot can resolve.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const postId = Number((await params).id)
  try {
    const post = await getPost(postId)
    if (post === null) return NextResponse.json({ error: "Not found" }, { status: 404 })

    const form = await req.formData()
    const file = form.get("file")
    const customer = normalizeCustomer(String(form.get("customer") ?? ""))
    const caption = String(form.get("caption") ?? "").trim()

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

    // The resolver takes a path, and HEIC has to be decoded first — an iPhone
    // screenshot forwarded from a DM arrives in whatever the phone saved.
    const dir = await mkdtemp(join(tmpdir(), "wa-dm-"))
    const scratch = join(dir, "reply.jpg")
    try {
      await writeFile(scratch, await decodable(Buffer.from(await file.arrayBuffer())))

      const { claimIds, repeats } = await ingestImageReply({
        postId,
        // No number: she wrote privately, and the handle is what everything
        // downstream keys on anyway.
        sender: "",
        messageId: "",
        replyPath: scratch,
        caption,
      })

      // Attributed after the fact rather than through the resolver, which only
      // knows about senders. Without this the claims would sit in review with
      // nobody to invoice — the very state this route exists to avoid.
      if (claimIds.length > 0) {
        await sql`
          UPDATE wa_claims
          SET customer = ${customer},
              state = CASE WHEN state = 'review' THEN 'pending' ELSE state END,
              updated_at = NOW()
          WHERE id = ANY(${claimIds})
        `
      }

      return NextResponse.json({ claims: claimIds.length, repeats })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  } catch (err) {
    console.error("Failed to read a marked photo from a DM:", err)
    return NextResponse.json({ error: "Failed to read that photo" }, { status: 500 })
  }
}
