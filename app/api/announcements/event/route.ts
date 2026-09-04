import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { eventNoticeRecipients, notifyEventCustomers } from "@/lib/db/announcements"
import { withActor } from "@/lib/db"
import { unknownTokens } from "@/lib/notice-templates"

// One notice to everybody on one trip. Owner-only, like the rest of
// /api/announcements — guarded here rather than by middleware, whose matcher
// never sees a path beginning /api.
async function denyUnlessOwner(): Promise<NextResponse | null> {
  const { session, error } = await requireSession()
  if (error) return error
  const owner = requireOwner(session)
  if (owner) return owner
  return null
}

const MAX_TITLE = 120
const MAX_BODY = 4000

/** Who it would reach, so the list can be read before forty notices go out. */
export async function GET(req: NextRequest) {
  const denied = await denyUnlessOwner()
  if (denied) return denied

  const event = req.nextUrl.searchParams.get("event")?.trim()
  if (!event) return NextResponse.json({ error: "event is required" }, { status: 400 })
  const skipShipped = req.nextUrl.searchParams.get("skipShipped") !== "0"
  const onlyUnpaid = req.nextUrl.searchParams.get("onlyUnpaid") === "1"

  try {
    const recipients = await eventNoticeRecipients(event, { skipShipped, onlyUnpaid })
    return NextResponse.json({ recipients })
  } catch (err) {
    console.error("Failed to list notice recipients:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error } = await requireSession()
  if (error) return error
  const owner = requireOwner(session)
  if (owner) return owner

  try {
    const body = await req.json()
    const event = String(body.event ?? "").trim()
    const title = String(body.title ?? "").trim()
    const text = String(body.body ?? "").trim()
    if (!event) return NextResponse.json({ error: "Pick a trip" }, { status: 400 })
    if (!title) return NextResponse.json({ error: "A title is required" }, { status: 400 })
    if (!text) return NextResponse.json({ error: "A message is required" }, { status: 400 })
    if (title.length > MAX_TITLE) {
      return NextResponse.json({ error: `Title must be ${MAX_TITLE} characters or fewer` }, { status: 400 })
    }
    if (text.length > MAX_BODY) {
      return NextResponse.json({ error: `Message must be ${MAX_BODY} characters or fewer` }, { status: 400 })
    }

    // A placeholder she would read literally is worse than a shorter sentence,
    // so a typo'd one stops the send rather than reaching forty inboxes.
    const bad = unknownTokens(`${title} ${text}`)
    if (bad.length) {
      return NextResponse.json(
        { error: `${bad.join(", ")} is not a placeholder we know` },
        { status: 400 },
      )
    }

    // The tokens are filled per recipient, inside the send: {outstanding} has
    // a different answer for each of them, and one figure sent to everybody
    // would be right for one person and wrong for thirty-nine.
    const result = await withActor(session.user.email, (tx) => notifyEventCustomers(
      event,
      { title, body: text },
      { skipShipped: body.skipShipped !== false, onlyUnpaid: body.onlyUnpaid === true },
      tx,
    ))
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    console.error("Failed to send trip notice:", err)
    return NextResponse.json({ error: "Failed to send" }, { status: 500 })
  }
}
