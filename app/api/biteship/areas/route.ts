import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { searchAreas, BiteshipNotConfiguredError } from "@/lib/biteship"

/**
 * Search Biteship's areas, for staff choosing one by hand.
 *
 * Every call is billed, so this is deliberately not a search-as-you-type
 * endpoint: the screen calls it when somebody presses the button, and the
 * library caches an answer for a day. Two letters would match half the country
 * and cost money to say so, which is why the minimum is three.
 */
export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim()
  if (q.length < 3) {
    return NextResponse.json({ areas: [] })
  }

  try {
    const areas = await searchAreas(q)
    // Eight is what fits on the screen without scrolling. More than that means
    // the query was too vague to choose from anyway.
    return NextResponse.json({
      areas: areas.slice(0, 8).map((a) => ({ id: a.id, name: a.name })),
    })
  } catch (err) {
    if (err instanceof BiteshipNotConfiguredError) {
      return NextResponse.json({ error: "Biteship is not configured" }, { status: 503 })
    }
    console.error("Area search failed:", err)
    return NextResponse.json({ error: "Area search failed" }, { status: 502 })
  }
}
