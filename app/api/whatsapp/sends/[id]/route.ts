import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import sql from "@/lib/db-pool"
import { getSend, listSendCodes } from "@/lib/db/wa-sends"

type Params = { params: Promise<{ id: string }> }

/** One send plus its coded lines. Owner-only, matching every other route
 *  in this composer. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const id = Number((await params).id)
  const send = await getSend(id)
  if (!send) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const codes = await listSendCodes(id)
  return NextResponse.json({ send, codes }, { headers: { "Cache-Control": "no-store" } })
}

/** Discard a draft send. Refuses once the send has actually gone out
 *  (message_id set) — at that point it's a record of what customers were
 *  shown, not a draft. wa_send_codes and wa_outbox rows cascade via their
 *  send_id FKs (ON DELETE CASCADE, migration 081), so a single delete here
 *  is enough. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const id = Number((await params).id)
  const send = await getSend(id)
  if (!send) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (send.messageId) {
    return NextResponse.json({ error: "A send that has already gone out cannot be deleted" }, { status: 400 })
  }
  await sql`DELETE FROM wa_sends WHERE id = ${id}`
  return NextResponse.json({ success: true })
}
