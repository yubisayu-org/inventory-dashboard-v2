import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getSend, listSendCodes } from "@/lib/db/wa-sends"
import { renderCaption } from "@/lib/whatsapp/product-post"
import { queueSend } from "@/lib/db/outbox"

type Params = { params: Promise<{ id: string }> }

/** Queue a composed send to go out to its trip's WhatsApp group. Owner or admin:
 *  this is the point of no return — the caption becomes what customers see. */
export async function POST(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const id = Number((await params).id)
  const send = await getSend(id)
  if (!send) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (send.messageId) {
    return NextResponse.json({ error: "Already sent" }, { status: 400 })
  }
  const codes = await listSendCodes(id)
  if (codes.length === 0) {
    return NextResponse.json({ error: "Attach at least one product before sending" }, { status: 400 })
  }

  const caption = renderCaption({ title: send.title }, codes)
  const queued = await queueSend(id, send.event, caption)
  if (!queued) {
    return NextResponse.json({ error: "This trip has no WhatsApp group bound to it" }, { status: 400 })
  }
  return NextResponse.json({ success: true })
}
