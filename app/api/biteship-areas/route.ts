import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { searchAreas, BiteshipNotConfiguredError } from "@/lib/biteship"

// Staff-side area search: warehouse origins, and the receiving area for a
// redirect recorded on the Packing List. Deliberately separate from the
// customer-facing /api/public/catalogue/areas -- same Biteship call, entirely
// different authorisation.
//
// Open to staff, not only the owner: it reads public postal areas and writes
// nothing, and the people recording "kirim ke rumah ibu saya" are the ones
// packing the boxes.

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

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
