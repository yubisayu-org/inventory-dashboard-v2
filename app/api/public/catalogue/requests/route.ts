import { NextRequest, NextResponse } from "next/server"
import { createCatalogueRequest, getCatalogueRequestsByCustomer } from "@/lib/db"
import { customerFromRequest } from "@/lib/catalogue-bearer"
import catalogueSql from "@/lib/db-catalogue-public"

// Public, no-login endpoints for the customer-facing catalogue site (a
// separate repo/deploy, mirroring how yubisayu-invoice.netlify.app consumes
// /api/public/invoice).
//
// TODO: swap for the real domain once the catalogue site is deployed.
const ALLOWED_ORIGIN = "https://yubisayu-catalogue.netlify.app"

const MAX_BODY_BYTES = 4 * 1024
const MAX_NOTE_LEN = 300

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET(req: NextRequest) {
  // The handle is never read from the request. Identity comes from the session
  // and nowhere else — a handle in a query string is a handle any stranger can
  // type, which is precisely how someone else's orders used to be readable.
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json(
      { error: "Not signed in" },
      { status: 401, headers: { ...corsHeaders(), "Cache-Control": "no-store" } },
    )
  }
  try {
    const requests = await getCatalogueRequestsByCustomer(customer.id, catalogueSql)
    return NextResponse.json(
      { requests },
      { headers: { ...corsHeaders(), "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to load catalogue requests:", err)
    return NextResponse.json(
      { error: "Failed to load requests" },
      { status: 500, headers: corsHeaders() },
    )
  }
}

export async function POST(req: NextRequest) {
  // Body-size guard (cheap rejection before parsing).
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

  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json(
      { error: "Not signed in" },
      { status: 401, headers: { ...corsHeaders(), "Cache-Control": "no-store" } },
    )
  }

  try {
    const b = body as Record<string, unknown>
    // Taken from the session, not the body: otherwise a caller could place an
    // order in somebody else's name.
    const customerHandle = customer.instagramId
    const productId = Number(b.productId)
    const qty = Number(b.qty)
    const note = String(b.note ?? "").trim()

    if (!Number.isInteger(productId) || productId < 1) {
      return NextResponse.json({ error: "productId must be a positive integer" }, { status: 400, headers: corsHeaders() })
    }
    if (!Number.isInteger(qty) || qty < 1) {
      return NextResponse.json({ error: "qty must be a positive integer" }, { status: 400, headers: corsHeaders() })
    }
    if (note.length > MAX_NOTE_LEN) {
      return NextResponse.json(
        { error: `note must be ${MAX_NOTE_LEN} characters or fewer` },
        { status: 400, headers: corsHeaders() },
      )
    }

    const postIdRaw = b.postId
    let postId: number | null = null
    if (postIdRaw !== undefined && postIdRaw !== null) {
      postId = Number(postIdRaw)
      if (!Number.isInteger(postId) || postId < 1) {
        return NextResponse.json({ error: "postId must be a positive integer" }, { status: 400, headers: corsHeaders() })
      }
    }

    await createCatalogueRequest(
      { customerHandle, customerId: customer.id, productId, qty, note, postId },
      catalogueSql,
    )
    return NextResponse.json({ success: true }, { headers: corsHeaders() })
  } catch (err) {
    console.error("Failed to save catalogue request:", err)
    return NextResponse.json({ error: "Failed to save request" }, { status: 500, headers: corsHeaders() })
  }
}
