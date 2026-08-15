import { NextRequest, NextResponse } from "next/server"
import { createCatalogueRequest, getCatalogueRequestsByHandle } from "@/lib/db"
import catalogueSql from "@/lib/db-catalogue-public"

// Public, no-login endpoints for the customer-facing catalogue site (a
// separate repo/deploy, mirroring how yubisayu-invoice.netlify.app consumes
// /api/public/invoice).
//
// TODO: swap for the real domain once the catalogue site is deployed.
const ALLOWED_ORIGIN = "https://yubisayu-catalogue.netlify.app"

const MAX_BODY_BYTES = 4 * 1024
const MAX_HANDLE_LEN = 30 // Instagram's own max handle length
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
  const handle = req.nextUrl.searchParams.get("handle")?.trim()
  if (!handle) {
    return NextResponse.json({ error: "handle is required" }, { status: 400, headers: corsHeaders() })
  }
  try {
    const requests = await getCatalogueRequestsByHandle(handle, catalogueSql)
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

  try {
    const body = JSON.parse(raw)
    const customerHandle = String(body.customerHandle ?? "").trim()
    const productId = Number(body.productId)
    const qty = Number(body.qty)
    const note = String(body.note ?? "").trim()

    if (!customerHandle || customerHandle.length > MAX_HANDLE_LEN) {
      return NextResponse.json({ error: "A valid customerHandle is required" }, { status: 400, headers: corsHeaders() })
    }
    if (!/^@?[a-zA-Z0-9._]{1,30}$/.test(customerHandle)) {
      return NextResponse.json({ error: "Invalid customerHandle" }, { status: 400, headers: corsHeaders() })
    }
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

    await createCatalogueRequest({ customerHandle, productId, qty, note }, catalogueSql)
    return NextResponse.json({ success: true }, { headers: corsHeaders() })
  } catch (err) {
    console.error("Failed to save catalogue request:", err)
    return NextResponse.json({ error: "Failed to save request" }, { status: 500, headers: corsHeaders() })
  }
}
