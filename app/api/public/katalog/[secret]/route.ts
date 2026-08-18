import { NextResponse } from "next/server"
import sql from "@/lib/db-pool"
import { eventForSecret } from "@/lib/katalog/secret"

type Params = { params: Promise<{ secret: string }> }

/**
 * The shelves of one trip, for the customer-facing catalogue.
 *
 * Public, no login: not matched by middleware, which guards only /dashboard.
 * A trip is reachable only by the unguessable secret in the URL, and only while
 * its event is active — an old trip's link goes dead when the event closes,
 * which is the revocation this prototype has.
 *
 * Deliberately thin: shelf id, size, and the pen colours that stand out against
 * that photograph. No claims, no counts, no customers. What other people
 * ordered is nobody else's business, and this route is the one place a stranger
 * with a shared link can look.
 */
export async function GET(_req: Request, { params }: Params) {
  const { secret } = await params
  try {
    const events = await sql`SELECT name FROM events WHERE is_active ORDER BY name`
    const event = eventForSecret(secret, events.map((r) => r.name as string))
    if (event === null) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const rows = await sql`
      SELECT p.id, p.store, p.image_width, p.image_height, p.safe_hues, p.created_at
      FROM wa_posts p
      WHERE p.event = ${event}
      ORDER BY p.id ASC
    `

    return NextResponse.json(
      {
        event,
        shelves: rows.map((r) => ({
          id: r.id as number,
          store: (r.store as string) ?? "",
          width: (r.image_width as number) ?? 0,
          height: (r.image_height as number) ?? 0,
          hues: ((r.safe_hues as number[]) ?? []).map(Number),
        })),
      },
      // Short: a trip gains shelves through the day, and a latecomer opening the
      // link wants the rack you photographed ten minutes ago.
      { headers: { "Cache-Control": "public, max-age=60" } },
    )
  } catch (err) {
    console.error("Failed to load catalogue:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}
