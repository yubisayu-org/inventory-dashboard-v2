import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { holdPackingList, withActor } from "@/lib/db"
import { notifyCustomer } from "@/lib/db/announcements"

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const { customer, event } = body as { customer?: string; event?: string }
    if (!customer || !event) {
      return NextResponse.json({ error: "customer and event are required" }, { status: 400 })
    }
    // Only the shop's own hold reaches her inbox. A hold she asked for herself
    // goes through lib/db/shipping-prefs, which stays quiet — telling someone
    // what they just did is noise, not news.
    await withActor(session.user.email, async (tx) => {
      await holdPackingList({ customer, event }, tx)
      await notifyCustomer(customer, {
        title: `${event} is on hold`,
        body: `The shop has paused this order in the packing queue, so nothing ships for now. `
          + `Message the shop if that is unexpected.`,
      }, tx)
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to hold packing list:", err)
    return NextResponse.json({ error: "Failed to hold packing list" }, { status: 500 })
  }
}
