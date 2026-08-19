import { NextRequest, NextResponse } from "next/server"
import { customerFromRequest } from "@/lib/catalogue-bearer"
import { corsHeaders, privateHeaders } from "@/lib/catalogue-cors"
import { searchAreas, BiteshipNotConfiguredError } from "@/lib/biteship"

// Area autocomplete for the customer profile sheet.
//
// This is a PAID endpoint reachable by any signed-in customer, so it is gated
// three ways: a session is required, the query must be at least three
// characters, and each customer gets a per-minute budget. Without those, one
// person holding a key down spends real money.

const RATE_LIMIT_WINDOW = 60_000
const RATE_LIMIT_MAX = 20 // generous for typing one address, useless for abuse

const usage = new Map<number, { windowStart: number; count: number }>()

function overBudget(customerId: number): boolean {
  const now = Date.now()
  const entry = usage.get(customerId)
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    usage.set(customerId, { windowStart: now, count: 1 })
    return false
  }
  entry.count++
  return entry.count > RATE_LIMIT_MAX
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET(req: NextRequest) {
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: privateHeaders() })
  }
  if (overBudget(customer.id)) {
    return NextResponse.json(
      { error: "Too many searches. Please wait a moment." },
      { status: 429, headers: privateHeaders() },
    )
  }

  const input = req.nextUrl.searchParams.get("q") ?? ""
  try {
    return NextResponse.json({ areas: await searchAreas(input) }, { headers: privateHeaders() })
  } catch (err) {
    if (err instanceof BiteshipNotConfiguredError) {
      // Said plainly rather than as a 500: this is a deployment gap, and the
      // person hitting it should not be told the server is broken.
      return NextResponse.json(
        { error: "Address search is not configured yet.", notConfigured: true },
        { status: 503, headers: privateHeaders() },
      )
    }
    console.error("Biteship area search failed:", err)
    return NextResponse.json(
      { error: "Address search is unavailable. Please try again." },
      { status: 502, headers: privateHeaders() },
    )
  }
}
