import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { releasePackingList, withActor } from "@/lib/db"
import { clearHoldMode } from "@/lib/db/shipping-prefs"
import sql from "@/lib/db-pool"
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
    // The staff screens work in handles; the preference table is keyed by id.
    const [row] = (await sql`
      SELECT id FROM customers
       WHERE lower(replace(instagram_id, '@', '')) = lower(replace(${customer}, '@', ''))
    `) as unknown as { id: number }[]

    await withActor(session.user.email, async (tx) => {
      await releasePackingList({ customer, event }, tx)
      // And forget that anyone asked. Freeing the units alone left the request
      // on file, and the next arrival read it and parked the order again --
      // undoing this release through an action nobody connected to it.
      // releasePackingList still runs first, and unconditionally: a hold set
      // before any of this existed has no row here to clear.
      if (row) await clearHoldMode(row.id, event, tx)
      await notifyCustomer(customer, {
        title: `${event} is back in the queue`,
        body: `The hold is lifted — this order goes out with the next run.`,
      }, tx)
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to release packing list:", err)
    return NextResponse.json({ error: "Failed to release packing list" }, { status: 500 })
  }
}
