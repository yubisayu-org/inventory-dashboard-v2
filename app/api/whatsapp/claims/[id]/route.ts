import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import sql from "@/lib/db-pool"
import { normalizeCustomer } from "@/lib/db/helpers"
import { markClaimObtained } from "@/lib/db/claims"
import { linkSenderToCustomer } from "@/lib/whatsapp/identity"

type Params = { params: Promise<{ id: string }> }

const STATES = ["pending", "assigned", "review", "rejected"] as const

/**
 * Correct one claim: who sent it, how many they want, whether it counts.
 *
 * Setting a customer also writes the number onto that customer's record, so the
 * same person never has to be identified twice — that is the whole of the
 * "ask once and remember" rule, and doing it anywhere else would make it
 * optional.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const id = Number((await params).id)
  try {
    const [claim] = await sql`SELECT id, sender FROM wa_claims WHERE id = ${id}`
    if (!claim) return NextResponse.json({ error: "Not found" }, { status: 404 })

    const body = await req.json()

    if (typeof body.customer === "string" && body.customer.trim()) {
      await linkSenderToCustomer(claim.sender as string, normalizeCustomer(body.customer))
    }

    if (body.quantity != null) {
      const quantity = Number(body.quantity)
      if (!Number.isInteger(quantity) || quantity < 1) {
        return NextResponse.json(
          { error: "quantity must be a whole number of 1 or more" },
          { status: 400 },
        )
      }
      await sql`UPDATE wa_claims SET quantity = ${quantity}, updated_at = NOW() WHERE id = ${id}`
    }

    // Zero is a real answer here too — "I ticked it by mistake".
    if (body.obtained != null) {
      const obtained = Number(body.obtained)
      if (!Number.isInteger(obtained) || obtained < 0) {
        return NextResponse.json({ error: "obtained must be zero or more" }, { status: 400 })
      }
      await markClaimObtained(id, obtained)
    }

    if (typeof body.state === "string") {
      if (!STATES.includes(body.state as (typeof STATES)[number])) {
        return NextResponse.json(
          { error: `state must be one of ${STATES.join(", ")}` },
          { status: 400 },
        )
      }
      await sql`UPDATE wa_claims SET state = ${body.state}, updated_at = NOW() WHERE id = ${id}`
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    if (err instanceof Error && /no such customer|both required/.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    console.error("Failed to update claim:", err)
    return NextResponse.json({ error: "Failed to update" }, { status: 500 })
  }
}
