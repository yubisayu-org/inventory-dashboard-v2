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
    // Only trips with shelves on them. A catalogue is the shelf photographs,
    // so a trip without any has nothing to publish and its row here would be a
    // link to an empty page.
    //
    // And read the secret, never mint one. katalogSecret() creates on demand —
    // right for the moment a link is asked for, wrong for a listing, which
    // would quietly hand every running trip a live URL just for opening
    // Settings. That is the opposite of the lazy minting it documents.
    const rows = await sql`
      SELECT e.name, e.catalog_secret, count(p.id)::int AS shelves
      FROM events e
      JOIN wa_posts p ON p.event = e.name
      WHERE e.is_active
      GROUP BY e.name, e.catalog_secret, e.id
      ORDER BY e.id DESC
    `
    const links = rows.map((row) => ({
      event: row.name as string,
      url: row.catalog_secret ? catalogueUrl(row.catalog_secret as string) : "",
      shelves: row.shelves as number,
    }))
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

    // "create" mints the first link for a trip; "rotate" retires the current
    // one. Separate words because they read differently to the person doing
    // them, even though the second is the first plus a consequence.
    if (body.action === "create") {
      const secret = await katalogSecret(event)
      if (!secret) return NextResponse.json({ error: "No such trip" }, { status: 404 })
      return NextResponse.json({ event, url: catalogueUrl(secret) })
    }

    return NextResponse.json({ event, url: catalogueUrl(await rotateKatalogSecret(event)) })
  } catch (err) {
    console.error("Failed to rotate a catalogue link:", err)
    return NextResponse.json({ error: "Failed to rotate" }, { status: 500 })
  }
}
