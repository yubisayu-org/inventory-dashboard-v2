import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { withActor } from "@/lib/db"
import { setShippingMode, setMergeGroup, setTempAddress } from "@/lib/db/shipping-prefs"
import { reconcileParcelPlan } from "@/lib/db/parcel-plan"
import sql from "@/lib/db-pool"

const ACTIONS = ["split", "unsplit", "merge", "unmerge", "address"] as const
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

    // Where a parcel is going changes no plan, but since the redirect prices
    // itself it does change the bill: setTempAddress quotes the new area and
    // writes the difference as an automatic adjustment, exactly as it does
    // when she asks from her own page. Recording what she said on WhatsApp and
    // her recording it herself must not cost different amounts.
    //
    // It still returns no adjustment to the caller, and reconciles nothing:
    // the charge is written where every other automatic one is, and the Ship
    // card reads it back from there.
    if (action === "address") {
      const address = typeof body.address === "string" ? body.address : ""
      const areaId = typeof body.areaId === "string" ? body.areaId : null
      const areaName = typeof body.areaName === "string" ? body.areaName : null
      // Who the courier should ask for, when it is not her.
      const name = typeof body.name === "string" ? body.name : ""
      const phone = typeof body.phone === "string" ? body.phone : ""
      await withActor(session.user.email, (tx) =>
        setTempAddress(row.id, events[0], { address, areaId, areaName, name, phone }, tx, "shop"))
      return NextResponse.json({ success: true })
    }

    const adjustment = await withActor(session.user.email, async (tx) => {
      if (action === "split") await setShippingMode(row.id, events[0], "split", tx, "shop")
      else if (action === "unsplit") await setShippingMode(row.id, events[0], "wait", tx, "shop")
      else if (action === "merge") await setMergeGroup(row.id, events, tx, "shop")
      // A group of one is not a group, so naming a single member clears the
      // whole thing — its partners are released as orphans. An empty list
      // would clear nothing at all: the orphan search starts from the events
      // it was given, and given none it finds none.
      else await setMergeGroup(row.id, [events[0]], tx, "shop")

      // After the plan is stored, so it prices what is now true. Every trip
      // the change touched, not only the first: a partner released from a
      // group is priced as its own parcel again, and would otherwise keep a
      // discount for a box it no longer shares.
      const priced = await Promise.all(
        events.map((e) => reconcileParcelPlan(customer, e, tx)),
      )
      return priced[0]
    })

    return NextResponse.json({ success: true, adjustment })
  } catch (err) {
    // A refused plan — the parcel already shipped, no order on the trip — is
    // something the person can act on, not a server fault. Its reason arrives
    // as a bare code from ShippingPrefError, which is fine in a log and no use
    // at all on a screen.
    const raw = err instanceof Error ? err.message : "Failed to record the plan"
    const message = {
      shipped: "Paketnya sudah dikirim — tidak bisa diubah lagi",
      unknown: "Tidak ada pesanan di trip ini",
      unpaid: "Pesanan ini belum lunas",
      "part-shipped": "Sebagian paketnya sudah dikirim",
    }[raw] ?? raw
    console.error("Failed to record parcel plan:", err)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
