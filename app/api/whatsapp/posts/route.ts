import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { listPosts } from "@/lib/db/claims"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const params = req.nextUrl.searchParams
  try {
    const result = await listPosts({
      event: params.get("event") ?? undefined,
      search: params.get("search") ?? undefined,
      page: Number(params.get("page")) || 1,
      pageSize: Number(params.get("pageSize")) || 25,
    })
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to list WhatsApp posts:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}
