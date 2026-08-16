import { NextRequest, NextResponse } from "next/server"
import { approveCatalogueRequestOffer } from "@/lib/db"
import catalogueSql from "@/lib/db-catalogue-public"

// TODO: swap for the real domain once the catalogue site is deployed.
const ALLOWED_ORIGIN = "https://yubisayu-catalogue.netlify.app"
const MAX_BODY_BYTES = 512

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

  const customerHandle = String((body as Record<string, unknown>).customerHandle ?? "").trim()
  if (!customerHandle) {
    return NextResponse.json({ error: "customerHandle is required" }, { status: 400, headers: corsHeaders() })
  }

  try {
    await approveCatalogueRequestOffer(id, customerHandle, catalogueSql)
    return NextResponse.json({ success: true }, { headers: corsHeaders() })
  } catch (err) {
    if (err instanceof Error && err.message === "Request not found or already handled") {
      return NextResponse.json({ error: err.message }, { status: 409, headers: corsHeaders() })
    }
    console.error("Failed to approve request offer:", err)
    return NextResponse.json({ error: "Failed to approve offer" }, { status: 500, headers: corsHeaders() })
  }
}
