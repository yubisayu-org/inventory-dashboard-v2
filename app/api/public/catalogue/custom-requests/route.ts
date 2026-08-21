import { NextRequest, NextResponse } from "next/server"
import { createCatalogueRequest } from "@/lib/db"
import catalogueSql from "@/lib/db-catalogue-public"

// Public, no-login endpoint for submitting a custom (product-less)
// catalogue request. See
// docs/superpowers/specs/2026-08-16-custom-order-requests-design.md.
// Mirrors app/api/public/catalogue/requests/route.ts's POST validation
// shape (body-size guard, JSON parse try/catch, handle regex, CORS).
//
// TODO: swap for the real domain once the catalogue site is deployed.
const ALLOWED_ORIGIN = "https://yubisayu-catalogue.netlify.app"

const MAX_BODY_BYTES = 4 * 1024
const MAX_HANDLE_LEN = 30
const MAX_NOTE_LEN = 300
const MAX_DESCRIPTION_LEN = 500

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

  // The only URL shape this endpoint accepts as a reference image — anything
  // else would make this route an open relay for arbitrary attacker-supplied
  // URLs stored in our own DB and rendered in the staff dashboard.
  const referenceImagePrefix = process.env.SUPABASE_URL
    ? `${process.env.SUPABASE_URL}/storage/v1/object/public/catalogue-reference/`
    : null

  // What the customer's own live estimate showed at submit time — best
  // effort, not validated the way the rest of this body is: a malformed
  // number here becomes null rather than rejecting an otherwise-valid
  // request over a field the customer never directly typed (it's computed
  // client-side from country/valas/weight). See migration 088.
  function toPositiveIntOrNull(v: unknown): number | null {
    const n = Number(v)
    return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null
  }
  function toPositiveNumberOrNull(v: unknown): number | null {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  try {
    const b = body as Record<string, unknown>
    const customerHandle = String(b.customerHandle ?? "").trim()
    const description = String(b.description ?? "").trim()
    const qty = Number(b.qty)
    const note = String(b.note ?? "").trim()
    const referenceImageUrl = b.referenceImageUrl ? String(b.referenceImageUrl).trim() : null
    const countryId = toPositiveIntOrNull(b.countryId)
    const valas = toPositiveNumberOrNull(b.valas)
    const gram = toPositiveNumberOrNull(b.gram)
    const estimatedPrice = toPositiveIntOrNull(b.estimatedPrice)

    if (!customerHandle || customerHandle.length > MAX_HANDLE_LEN) {
      return NextResponse.json({ error: "A valid customerHandle is required" }, { status: 400, headers: corsHeaders() })
    }
    if (!/^@?[a-zA-Z0-9._]{1,30}$/.test(customerHandle)) {
      return NextResponse.json({ error: "Invalid customerHandle" }, { status: 400, headers: corsHeaders() })
    }
    if (!description || description.length > MAX_DESCRIPTION_LEN) {
      return NextResponse.json(
        { error: `description is required and must be ${MAX_DESCRIPTION_LEN} characters or fewer` },
        { status: 400, headers: corsHeaders() },
      )
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
    let storedReferenceImageUrl = referenceImageUrl
    if (referenceImageUrl) {
      let ok = false
      try {
        const u = new URL(referenceImageUrl)
        const expected = new URL(referenceImagePrefix ?? "")
        ok =
          u.origin === expected.origin &&
          u.pathname.startsWith(expected.pathname) &&
          u.pathname !== expected.pathname
        if (ok) {
          // Rebuild from the validated URL's own origin+pathname rather than
          // storing whatever string was sent — strips query strings/fragments
          // and anything else riding along with an otherwise-valid URL.
          storedReferenceImageUrl = u.origin + u.pathname
        }
      } catch {
        // ok stays false — malformed URL is rejected
      }
      if (!ok) {
        return NextResponse.json({ error: "Invalid referenceImageUrl" }, { status: 400, headers: corsHeaders() })
      }
    }

    await createCatalogueRequest(
      {
        customerHandle, productId: null, description, qty, note,
        referenceImageUrl: storedReferenceImageUrl,
        countryId, valas, gram, estimatedPrice,
      },
      catalogueSql,
    )
    return NextResponse.json({ success: true }, { headers: corsHeaders() })
  } catch (err) {
    console.error("Failed to save custom catalogue request:", err)
    return NextResponse.json({ error: "Failed to save request" }, { status: 500, headers: corsHeaders() })
  }
}
