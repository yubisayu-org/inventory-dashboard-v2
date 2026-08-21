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

  // A running trip fits in one request; a season of finished ones does not, and
  // silently truncating an archive is how a shelf becomes unreachable.
  const pageSize = Math.min(200, Math.max(1, Number(params.get("pageSize")) || 100))
  const page = Math.max(1, Number(params.get("page")) || 1)

  /**
   * What the search box asks about.
   *
   * A shelf is findable by the shop it was photographed in, the trip it belongs
   * to, what its SKUs were named, and who claimed on it — handle or number.
   * "Which rack had the bear pyjamas" and "what did summerfey order" are asked
   * mid-trip, and the only answer used to be opening shelves one at a time.
   *
   * Digits are compared stripped, because a number is written a dozen ways —
   * 0811…, +62 811…, 62811… — and none of them is the one stored.
   */
  const search = (params.get("search") ?? "").trim().toLowerCase()
  const digits = search.replace(/\D/g, "")
  const like = search ? `%${search}%` : null
  const digitsLike = digits.length >= 3 ? `%${digits}%` : null

  const matches = search
    ? sql`AND (
        lower(p.store) LIKE ${like}
        OR lower(p.event) LIKE ${like}
        OR lower(p.note) LIKE ${like}
        OR EXISTS (
          SELECT 1 FROM wa_slots ms
          LEFT JOIN products mp ON mp.id = ms.product_id
          WHERE ms.post_id = p.id
            AND (lower(ms.label) LIKE ${like} OR lower(mp.name) LIKE ${like})
        )
        OR EXISTS (
          SELECT 1 FROM wa_claims mc
          WHERE mc.post_id = p.id AND mc.state <> 'rejected'
            AND (
              lower(mc.customer) LIKE ${like}
              OR lower(mc.note) LIKE ${like}
              OR (${digitsLike}::text IS NOT NULL
                  AND regexp_replace(mc.sender, '\\D', '', 'g') LIKE ${digitsLike})
            )
        )
      )`
    : sql``

  try {
    const rows = await sql`
      SELECT p.id, p.event, p.store, p.created_at, p.message_id, e.is_active,
             COUNT(DISTINCT s.id)::int AS sku,
             COALESCE(SUM(c.quantity), 0)::int AS claimed,
             COALESCE(SUM(c.obtained), 0)::int AS bought
      FROM wa_posts p
      JOIN events e ON e.name = p.event AND ${archived ? sql`NOT e.is_active` : sql`e.is_active`}
      LEFT JOIN wa_slots s ON s.post_id = p.id
      LEFT JOIN wa_claims c ON c.slot_id = s.id AND c.state <> 'rejected'
      WHERE TRUE ${matches}
      GROUP BY p.id, e.is_active
      -- A shelf nobody claimed anything on is nothing to shop for. They are
      -- common — a rack is photographed, the group ignores it — and each one
      -- listed is a rack walked to for no reason. A shelf that is fully bought
      -- still has claims, so it stays, marked Done.
      HAVING ${all ? sql`TRUE` : sql`COALESCE(SUM(c.quantity), 0) > 0`}
      ORDER BY p.id DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `

    const [{ total }] = await sql`
      SELECT COUNT(*)::int AS total
      FROM (
        SELECT p.id
        FROM wa_posts p
        JOIN events e ON e.name = p.event AND ${archived ? sql`NOT e.is_active` : sql`e.is_active`}
        LEFT JOIN wa_slots s ON s.post_id = p.id
        LEFT JOIN wa_claims c ON c.slot_id = s.id AND c.state <> 'rejected'
        WHERE TRUE ${matches}
        GROUP BY p.id
        HAVING ${all ? sql`TRUE` : sql`COALESCE(SUM(c.quantity), 0) > 0`}
      ) AS counted
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
          // Empty until the bot actually posts it — see wa_posts.message_id.
          messageId: (r.message_id as string) ?? "",
          sku: r.sku as number,
          claimed: r.claimed as number,
          bought: r.bought as number,
        })),
        totalCount: total as number,
        page,
        pageSize,
      },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to list shop posts:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}
