import { NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import sql from "@/lib/db-pool"
import { tsToString } from "@/lib/db/helpers"

/**
 * Posts worth walking a shop with: the ones on an event that is still running.
 *
 * Its own route rather than a filter on /api/whatsapp/posts, which is
 * owner-only. An admin counting a shelf needs the shelves, not the archive.
 */
export async function GET(req: Request) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  // Shelves nobody claimed anything on are hidden by default — a rack the group
  // ignored is nothing to shop for — but they are still shelves, and sometimes
  // the question is "did that rack ever get posted?".
  const params = new URL(req.url).searchParams
  const all = params.get("all") === "true"
  // One or the other, never both: a finished trip's shelves cannot be shopped,
  // and mixed into today's they would sit there looking identical.
  const archived = params.get("archived") === "true"

  try {
    const rows = await sql`
      SELECT p.id, p.event, p.store, p.created_at, e.is_active,
             COUNT(DISTINCT s.id)::int AS sku,
             COALESCE(SUM(c.quantity), 0)::int AS claimed,
             COALESCE(SUM(c.obtained), 0)::int AS bought
      FROM wa_posts p
      JOIN events e ON e.name = p.event AND ${archived ? sql`NOT e.is_active` : sql`e.is_active`}
      LEFT JOIN wa_slots s ON s.post_id = p.id
      LEFT JOIN wa_claims c ON c.slot_id = s.id AND c.state <> 'rejected'
      GROUP BY p.id, e.is_active
      -- A shelf nobody claimed anything on is nothing to shop for. They are
      -- common — a rack is photographed, the group ignores it — and each one
      -- listed is a rack walked to for no reason. A shelf that is fully bought
      -- still has claims, so it stays, marked Done.
      HAVING ${all ? sql`TRUE` : sql`COALESCE(SUM(c.quantity), 0) > 0`}
      ORDER BY p.id DESC
      LIMIT 100
    `
    return NextResponse.json(
      {
        posts: rows.map((r) => ({
          id: r.id as number,
          event: r.event as string,
          store: (r.store as string) ?? "",
          // When the shelf was recorded — the photograph's own moment, which is
          // what tells two racks of the same shop apart at a glance.
          createdAt: tsToString(r.created_at as Date | null),
          // Whether its trip is still running, so a closed one can say so
          // rather than sitting among today's shelves looking identical.
          active: Boolean(r.is_active),
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
