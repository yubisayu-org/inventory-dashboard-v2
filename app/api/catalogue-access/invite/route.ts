import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { issueInvite } from "@/lib/db/catalogue-auth"
import { bulkInviteExistingCustomers, inviteByHandle, NoCustomerError, inviteUrl } from "@/lib/db/catalogue-access"

// Issue or re-issue an invite. Re-issuing supersedes the customer's earlier
// unredeemed invites, so only the newest link works — otherwise every link the
// shop has ever sent them stays live.
//
// Three shapes, by body:
//   { customerId }          — someone already on the admin list
//   { handle, create? }     — someone named by their Instagram handle, who may
//                             have no customers row yet
//   { bulk: true }          — every customer with catalogue history who has
//                             never signed in
//
// The handle shape answers 409 no_customer rather than creating on sight. The
// client turns that into a confirmation and posts again with create: true, so
// a mistyped handle cannot quietly mint a customer nobody meant to add.

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  let body: { customerId?: unknown; bulk?: unknown; handle?: unknown; create?: unknown }
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

    if (typeof body.handle === "string") {
      try {
        const invite = await inviteByHandle(body.handle, { create: body.create === true })
        return NextResponse.json({
          url: invite.url,
          instagramId: invite.instagramId,
          created: invite.created,
        })
      } catch (err) {
        if (err instanceof NoCustomerError) {
          return NextResponse.json(
            { error: "no_customer", handle: err.handle },
            { status: 409 },
          )
        }
        throw err
      }
    }

    const customerId = Number(body.customerId)
    if (!Number.isInteger(customerId) || customerId < 1) {
      return NextResponse.json({ error: "customerId must be a positive integer" }, { status: 400 })
    }
    const token = await issueInvite(customerId)
    return NextResponse.json({ token, url: inviteUrl(token) })
  } catch (err) {
    console.error("Failed to issue catalogue invite:", err)
    return NextResponse.json({ error: "Failed to issue invite" }, { status: 500 })
  }
}
