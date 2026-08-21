import { NextRequest, NextResponse } from "next/server"
import { takeOneTimeCode } from "@/lib/catalogue-one-time-code"
import { issueSession } from "@/lib/db/catalogue-auth"
import { corsHeaders, privateHeaders } from "@/lib/catalogue-cors"

// Trades the one-time code from /customer/callback for the session token.
// Runs on the main pool: customer_one_time_codes has no catalogue_public grant,
// deliberately — spending a code is not a public-role operation.

const MAX_BODY_BYTES = 4 * 1024

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function POST(req: NextRequest) {
  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: corsHeaders() })
  }

  let code: unknown
  try {
    code = (JSON.parse(raw || "{}") as { code?: unknown }).code
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() })
  }
  if (typeof code !== "string" || !code) {
    return NextResponse.json({ error: "code is required" }, { status: 400, headers: corsHeaders() })
  }

  try {
    const customerId = await takeOneTimeCode(code)
    // Spent, expired and never-existed are one answer on purpose: telling them
    // apart would let a caller probe which codes were once real.
    if (!customerId) {
      return NextResponse.json(
        { error: "Invalid or expired code" },
        { status: 400, headers: privateHeaders() },
      )
    }
    // Minted only now that the code has been spent, so an unspent code is
    // never a usable credential.
    const token = await issueSession(customerId)
    return NextResponse.json({ token }, { headers: privateHeaders() })
  } catch (err) {
    console.error("Failed to exchange catalogue session code:", err)
    return NextResponse.json({ error: "Failed to sign in" }, { status: 500, headers: corsHeaders() })
  }
}
