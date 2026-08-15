import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { convertCatalogueRequest, rejectCatalogueRequest } from "@/lib/db"

type Params = { params: Promise<{ id: string }> }

export async function PUT(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    const body = await req.json()

    if (body.action === "convert") {
      const event = String(body.event ?? "")
      if (!event) return NextResponse.json({ error: "event is required" }, { status: 400 })
      try {
        const result = await convertCatalogueRequest(id, event, session.user.email ?? null)
        return NextResponse.json({ success: true, orderId: result.orderId })
      } catch (err) {
        if (isGuardViolation(err)) return NextResponse.json({ error: err.message }, { status: 409 })
        throw err
      }
    }

    if (body.action === "reject") {
      const staffNote = String(body.staffNote ?? "")
      try {
        await rejectCatalogueRequest(id, staffNote)
        return NextResponse.json({ success: true })
      } catch (err) {
        if (isGuardViolation(err)) return NextResponse.json({ error: err.message }, { status: 409 })
        throw err
      }
    }

    return NextResponse.json({ error: "action must be 'convert' or 'reject'" }, { status: 400 })
  } catch (err) {
    console.error("Failed to update order request:", err)
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to update request" }, { status: 500 })
  }
}

// `convertCatalogueRequest`/`rejectCatalogueRequest` (lib/db/catalogue-requests.ts) throw this
// exact message when the request is already converted/rejected or doesn't exist — a
// user-actionable guard violation, not a server error. Matches the specific-catch treatment in
// app/api/sheets/duplicate-form/[row]/route.ts (returnOrderUnitsToExcess guard).
function isGuardViolation(err: unknown): err is Error {
  return err instanceof Error && err.message === "Request not found or already handled"
}
