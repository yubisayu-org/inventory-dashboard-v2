import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { withActor } from "@/lib/db"
import { setShippingMode, setMergeGroup } from "@/lib/db/shipping-prefs"
import { reconcileParcelPlan } from "@/lib/db/parcel-plan"
import sql from "@/lib/db-pool"

const ACTIONS = ["split", "unsplit", "merge", "unmerge"] as const
type Action = (typeof ACTIONS)[number]

/**
 * Staff record what the parcels are going to be.
 *
 * The customer has her own route for this; this one exists because the shop
 * decides most of them — of the plans in production, every one was arranged by
 * the shop and none by a customer. Both write the same preference. The
 * difference is `set_by`, so her page can say the shop arranged it rather than
 * showing her a choice she does not remember making.
 */
export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const action = String(body.action ?? "") as Action
    const customer = String(body.customer ?? "").trim()
    const events: string[] = Array.isArray(body.events)
      ? body.events.map((e: unknown) => String(e).trim()).filter(Boolean)
      : []

    if (!ACTIONS.includes(action)) {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 })
    }
    if (!customer || events.length === 0) {
      return NextResponse.json({ error: "customer and events are required" }, { status: 400 })
    }
    if (action === "merge" && events.length < 2) {
      return NextResponse.json({ error: "A merge needs at least two trips" }, { status: 400 })
    }

    const [row] = (await sql`
      SELECT id FROM customers
       WHERE lower(replace(instagram_id, '@', '')) = lower(replace(${customer}, '@', ''))
    `) as unknown as { id: number }[]
    if (!row) return NextResponse.json({ error: "Unknown customer" }, { status: 404 })

    const adjustment = await withActor(session.user.email, async (tx) => {
      if (action === "split") await setShippingMode(row.id, events[0], "split", tx, "shop")
      else if (action === "unsplit") await setShippingMode(row.id, events[0], "wait", tx, "shop")
      else if (action === "merge") await setMergeGroup(row.id, events, tx, "shop")
      else await setMergeGroup(row.id, [], tx, "shop")
      // After the plan is stored, so it prices what is now true.
      return await reconcileParcelPlan(customer, events[0], tx)
    })

    return NextResponse.json({ success: true, adjustment })
  } catch (err) {
    // A refused plan — the parcel already shipped, no order on the trip — is
    // something the person can act on, not a server fault.
    const message = err instanceof Error ? err.message : "Failed to record the plan"
    console.error("Failed to record parcel plan:", err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
