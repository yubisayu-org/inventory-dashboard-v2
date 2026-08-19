import { NextRequest, NextResponse } from "next/server"
import { createCatalogueUploadUrl } from "@/lib/storage"

// Public, no-login endpoint for the customer-facing catalogue site to get a
// signed Storage upload URL for a reference photo on a custom request. See
// docs/superpowers/specs/2026-08-16-custom-order-requests-design.md for why
// this two-step (get a URL, then PUT the file directly to Storage) shape
// exists instead of proxying file bytes through this app or the catalogue
// site's own Netlify Functions.
//
// TODO: swap for the real domain once the catalogue site is deployed.
const ALLOWED_ORIGIN = "https://yubisayu-catalogue.netlify.app"

// A `{"contentType": "..."}` body is tiny — this is just a guard against an
// oversized payload, same pattern as custom-requests/route.ts.
const MAX_BODY_BYTES = 1024

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

export async function POST(req: NextRequest) {
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

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() })
  }

  const contentType = String((body as Record<string, unknown>).contentType ?? "")

  try {
    const { uploadUrl, publicUrl } = await createCatalogueUploadUrl(contentType)
    return NextResponse.json({ uploadUrl, publicUrl }, { headers: corsHeaders() })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create upload URL"
    // createCatalogueUploadUrl's own "contentType must be..." message is the
    // one user-actionable case here (bad input) — everything else (Storage
    // failure, misconfiguration) is a genuine server error.
    const status = message.startsWith("contentType must be") ? 400 : 500
    console.error("Failed to create catalogue upload URL:", err)
    return NextResponse.json({ error: message }, { status, headers: corsHeaders() })
  }
}
