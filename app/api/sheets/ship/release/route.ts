import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { releasePackingList, withActor } from "@/lib/db"
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
    await withActor(session.user.email, async (tx) => {
      await releasePackingList({ customer, event }, tx)
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
