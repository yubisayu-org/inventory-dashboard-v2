import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import {
  listPendingAccessRequests,
  listCatalogueCustomers,
  approveAccessRequest,
  rejectAccessRequest,
} from "@/lib/db/catalogue-access"

// Owner-only: deciding who may see stock and pricing is not an admin task.

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const [requests, customers] = await Promise.all([
      listPendingAccessRequests(),
      listCatalogueCustomers(),
    ])
    return NextResponse.json({ requests, customers }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to load catalogue access:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  let body: { id?: unknown; action?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const id = Number(body.id)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "id must be a positive integer" }, { status: 400 })
  }
  if (body.action !== "approve" && body.action !== "reject") {
    return NextResponse.json({ error: "action must be approve or reject" }, { status: 400 })
  }

  try {
    if (body.action === "reject") {
      await rejectAccessRequest(id)
      return NextResponse.json({ ok: true })
    }
    // The token is returned exactly once. It is not stored in plaintext, so
    // losing it here means re-issuing rather than looking it up.
    const result = await approveAccessRequest(id)
    return NextResponse.json({
      instagramId: result.instagramId,
      customerId: result.customerId,
      token: result.token,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed"
    console.error("Failed to decide catalogue access request:", err)
    return NextResponse.json({ error: message }, { status: 409 })
  }
}
