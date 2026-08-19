import { NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { listRepostLibrary } from "@/lib/db/wa-sends"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const library = await listRepostLibrary()
  return NextResponse.json({ library }, { headers: { "Cache-Control": "no-store" } })
}
