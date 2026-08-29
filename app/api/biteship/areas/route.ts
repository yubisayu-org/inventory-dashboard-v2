import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { searchAreas, BiteshipNotConfiguredError } from "@/lib/biteship"
import { resolveRatesDistrict } from "@/lib/db"

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
    const shown = areas.slice(0, 8)
    // Each area carries the rates table's spelling of its district, so choosing
    // one can fill the address with a district that PRICES. Biteship's own
    // words never match jne_rates -- not once in 663 districts -- so filling
    // them verbatim would leave every new address unpriceable.
    const withDistrict = await Promise.all(shown.map(async (a) => {
      const [kec = "", kota = ""] = a.name
        .replace(/\.?\s*\d{5}\s*$/, "")
        .split(",")
        .map((p) => p.trim())
      return {
        id: a.id,
        name: a.name,
        district: await resolveRatesDistrict(kec, kota),
      }
    }))
    return NextResponse.json({ areas: withDistrict })
  } catch (err) {
    if (err instanceof BiteshipNotConfiguredError) {
      return NextResponse.json({ error: "Biteship is not configured" }, { status: 503 })
    }
    console.error("Area search failed:", err)
    return NextResponse.json({ error: "Area search failed" }, { status: 502 })
  }
}
