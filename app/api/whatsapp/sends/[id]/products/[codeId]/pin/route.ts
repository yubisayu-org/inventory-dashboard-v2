import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import sql from "@/lib/db-pool"

type Params = { params: Promise<{ id: string; codeId: string }> }

/** Persist where on the photo a tagged product's pin sits, as the same
 *  normalized 0..1 fraction a customer's own drawn mark would use. Scoped
 *  to the send in the URL (not just the code id) so a stray/forged codeId
 *  from a different send can't be repointed through this route. */
export async function PUT(req: NextRequest, { params }: Params) {
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

  const { x, y } = await req.json()
  if (typeof x !== "number" || typeof y !== "number" || x < 0 || x > 1 || y < 0 || y > 1) {
    return NextResponse.json({ error: "x and y must be numbers between 0 and 1" }, { status: 400 })
  }

  const rows = await sql`
    UPDATE wa_send_codes SET point_x = ${x}, point_y = ${y}
    WHERE id = ${codeIdNum} AND send_id = ${sendId}
    RETURNING id
  `
  if (rows.length === 0) {
    return NextResponse.json({ error: "Code not found on this send" }, { status: 404 })
  }
  return NextResponse.json({ success: true })
}
