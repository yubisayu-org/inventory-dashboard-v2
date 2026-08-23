import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { searchAreas, BiteshipNotConfiguredError } from "@/lib/biteship"

// Staff-side area search, for setting a warehouse origin. Owner-only and
// deliberately separate from the customer-facing /api/public/catalogue/areas:
// same Biteship call, entirely different authorisation.

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const areas = await searchAreas(req.nextUrl.searchParams.get("q") ?? "")
    return NextResponse.json({ areas }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    if (err instanceof BiteshipNotConfiguredError) {
      return NextResponse.json(
        { error: "BITESHIP_API_KEY is not set.", notConfigured: true },
        { status: 503 },
      )
    }
    console.error("Biteship area search failed:", err)
    return NextResponse.json({ error: "Address search is unavailable." }, { status: 502 })
  }
}
