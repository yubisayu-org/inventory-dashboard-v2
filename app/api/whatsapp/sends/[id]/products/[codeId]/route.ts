import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getSend, removeProductFromSend } from "@/lib/db/wa-sends"

type Params = { params: Promise<{ id: string; codeId: string }> }

/** Untag a product from a draft send. Refuses once the send has actually
 *  gone out — same rule as discarding a whole draft (DELETE /api/whatsapp/
 *  sends/[id]): a sent send is a record of what customers were shown, not
 *  something to edit after the fact. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const { id, codeId } = await params
  const sendId = Number(id)
  const codeIdNum = Number(codeId)
  if (!Number.isInteger(sendId) || sendId < 1 || !Number.isInteger(codeIdNum) || codeIdNum < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  const send = await getSend(sendId)
  if (!send) return NextResponse.json({ error: "Send not found" }, { status: 404 })
  if (send.messageId) {
    return NextResponse.json({ error: "A send that has already gone out cannot be edited" }, { status: 400 })
  }

  try {
    await removeProductFromSend(sendId, codeIdNum)
    return NextResponse.json({ success: true })
  } catch (err) {
    if (err instanceof Error && err.message === "code not found") {
      return NextResponse.json({ error: "Code not found on this send" }, { status: 404 })
    }
    console.error("Failed to remove product from send:", err)
    return NextResponse.json({ error: "Failed to remove product" }, { status: 500 })
  }
}
