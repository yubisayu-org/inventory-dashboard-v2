import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getCatalogueRequests } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const onlyPending = req.nextUrl.searchParams.get("all") !== "true"

  try {
    const requests = await getCatalogueRequests(onlyPending)
    return NextResponse.json({ requests }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch order requests:", err)
    return NextResponse.json({ error: "Failed to fetch order requests" }, { status: 500 })
  }
}
