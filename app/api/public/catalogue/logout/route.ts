import { NextRequest, NextResponse } from "next/server"
import { bearerToken } from "@/lib/catalogue-bearer"
import { revokeSession } from "@/lib/db/catalogue-auth"
import { corsHeaders, privateHeaders } from "@/lib/catalogue-cors"

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function POST(req: NextRequest) {
  const token = bearerToken(req)
  if (token) {
    try {
      await revokeSession(token)
    } catch (err) {
      // Reported as success regardless. Someone signing out on a shared device
      // must never be told it failed and left wondering; the catalogue site
      // clears its cookie either way.
      console.error("Failed to revoke catalogue session:", err)
    }
  }
  return NextResponse.json({ ok: true }, { headers: privateHeaders() })
}
