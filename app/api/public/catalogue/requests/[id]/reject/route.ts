import { NextRequest, NextResponse } from "next/server"
import { rejectCatalogueRequestOffer } from "@/lib/db"
import { customerFromRequest } from "@/lib/catalogue-bearer"
import catalogueSql from "@/lib/db-catalogue-public"
import { clientIp, createRateLimiter } from "@/lib/catalogue-rate-limit"

// TODO: swap for the real domain once the catalogue site is deployed.
const ALLOWED_ORIGIN = "https://yubisayu-catalogue.netlify.app"
const MAX_BODY_BYTES = 512

// Own independent counter — doesn't share a budget with approve/estimate-price.
const isRateLimited = createRateLimiter(60_000, 20)

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

type Params = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400, headers: corsHeaders() })
  }

  const ip = clientIp(req)
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: corsHeaders() })
  }

  const declaredLen = Number(req.headers.get("content-length") ?? 0)
  if (declaredLen > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: corsHeaders() })
  }
  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: corsHeaders() })
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() })
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() })
  }

  // Ownership comes from the session, not the body. With a handle in the body,
  // anyone could accept or decline another customer's offer given only a
  // request id — and ids are sequential.
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json(
      { error: "Not signed in" },
      { status: 401, headers: { ...corsHeaders(), "Cache-Control": "no-store" } },
    )
  }

  try {
    await rejectCatalogueRequestOffer(id, customer.id, catalogueSql)
    return NextResponse.json({ success: true }, { headers: corsHeaders() })
  } catch (err) {
    if (err instanceof Error && err.message === "Request not found or already handled") {
      return NextResponse.json({ error: err.message }, { status: 409, headers: corsHeaders() })
    }
    console.error("Failed to reject request offer:", err)
    return NextResponse.json({ error: "Failed to reject offer" }, { status: 500, headers: corsHeaders() })
  }
}
