import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import sql from "@/lib/db-pool"
import { catalogueUrl, katalogSecret, rotateKatalogSecret } from "@/lib/katalog/secret"

/**
 * The customer catalogue link for each running trip.
 *
 * The bot hands this out with /katalog, which is where it is normally wanted —
 * in the group, ready to pin. This exists for the times it is not: a link to
 * paste into a caption, a trip whose group is not connected yet, or simply
 * checking what the customers can see.
 *
 * Owner-only. The link is unguessable and grants a stranger the shelves of one
 * trip; who holds it is the owner's decision.
 */
export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const events = await sql`SELECT name FROM events WHERE is_active ORDER BY id DESC`
    const links = await Promise.all(
      events.map(async (row) => {
        const event = row.name as string
        const secret = await katalogSecret(event)
        return { event, url: secret ? catalogueUrl(secret) : "" }
      }),
    )
    return NextResponse.json({ links }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to read catalogue links:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

/**
 * Retire a trip's link and issue another.
 *
 * What "the link got out" looks like as an action: everyone holding the old URL
 * loses access, and every other trip is untouched.
 */
export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const body = await req.json()
    const event = String(body.event ?? "").trim()
    if (!event) return NextResponse.json({ error: "An event is required" }, { status: 400 })

    return NextResponse.json({ event, url: catalogueUrl(await rotateKatalogSecret(event)) })
  } catch (err) {
    console.error("Failed to rotate a catalogue link:", err)
    return NextResponse.json({ error: "Failed to rotate" }, { status: 500 })
  }
}
