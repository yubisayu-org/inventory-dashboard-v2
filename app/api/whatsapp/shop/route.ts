import { NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import sql from "@/lib/db-pool"

/**
 * Posts worth walking a shop with: the ones on an event that is still running.
 *
 * Its own route rather than a filter on /api/whatsapp/posts, which is
 * owner-only. An admin counting a shelf needs the shelves, not the archive.
 */
export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const rows = await sql`
      SELECT p.id, p.event, p.store,
             COUNT(DISTINCT s.id)::int AS sku,
             COALESCE(SUM(c.quantity), 0)::int AS claimed,
             COALESCE(SUM(c.obtained), 0)::int AS bought
      FROM wa_posts p
      JOIN events e ON e.name = p.event AND e.is_active
      LEFT JOIN wa_slots s ON s.post_id = p.id
      LEFT JOIN wa_claims c ON c.slot_id = s.id AND c.state <> 'rejected'
      GROUP BY p.id
      ORDER BY p.id DESC
      LIMIT 100
    `
    return NextResponse.json(
      {
        posts: rows.map((r) => ({
          id: r.id as number,
          event: r.event as string,
          store: (r.store as string) ?? "",
          sku: r.sku as number,
          claimed: r.claimed as number,
          bought: r.bought as number,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to list shop posts:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}
