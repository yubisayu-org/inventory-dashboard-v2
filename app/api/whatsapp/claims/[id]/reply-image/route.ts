import { NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getClaimReplyImagePath } from "@/lib/db/claims"
import { downloadPostImage } from "@/lib/storage"

type Params = { params: Promise<{ id: string }> }

/**
 * The customer's own marked-up shelf photo, kept as proof of what she sent.
 *
 * Cached longer than the slot crop: unlike a crop, this never changes once
 * captured — the path is keyed to the message that produced it.
 */
export async function GET(_req: Request, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const id = Number((await params).id)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  const path = await getClaimReplyImagePath(id)
  if (path === null) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const image = await downloadPostImage(path)
  return new NextResponse(new Uint8Array(image), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" },
  })
}
