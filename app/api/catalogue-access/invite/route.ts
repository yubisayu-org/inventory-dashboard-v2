import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { issueInvite } from "@/lib/db/catalogue-auth"
import { bulkInviteExistingCustomers } from "@/lib/db/catalogue-access"

// Issue or re-issue an invite. Re-issuing supersedes the customer's earlier
// unredeemed invites, so only the newest link works — otherwise every link the
// shop has ever sent them stays live.

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  let body: { customerId?: unknown; bulk?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  try {
    if (body.bulk === true) {
      const invites = await bulkInviteExistingCustomers()
      return NextResponse.json({ invites, count: invites.length })
    }

    const customerId = Number(body.customerId)
    if (!Number.isInteger(customerId) || customerId < 1) {
      return NextResponse.json({ error: "customerId must be a positive integer" }, { status: 400 })
    }
    return NextResponse.json({ token: await issueInvite(customerId) })
  } catch (err) {
    console.error("Failed to issue catalogue invite:", err)
    return NextResponse.json({ error: "Failed to issue invite" }, { status: 500 })
  }
}
