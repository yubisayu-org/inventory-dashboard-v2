import { NextRequest, NextResponse } from "next/server"
import { createCatalogueRequest } from "@/lib/db"
import { customerFromRequest } from "@/lib/catalogue-bearer"
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

/** A positive integer, or null. Never throws: a malformed estimate input must
 *  not stop a customer submitting a request they otherwise filled in fine. */
function optionalPositiveInt(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

function optionalPositiveNumber(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
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

  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json(
      { error: "Not signed in" },
      { status: 401, headers: { ...corsHeaders(), "Cache-Control": "no-store" } },
    )
  }

  try {
    const b = body as Record<string, unknown>
    // From the session, not the body — a custom request must belong to the
    // person who is signed in.
    const customerHandle = customer.instagramId
    const description = String(b.description ?? "").trim()
    const qty = Number(b.qty)
    const note = String(b.note ?? "").trim()
    const referenceImageUrl = b.referenceImageUrl ? String(b.referenceImageUrl).trim() : null

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
        customerHandle,
        customerId: customer.id,
        productId: null,
        description,
        qty,
        note,
        referenceImageUrl: storedReferenceImageUrl,
        // Kept rather than dropped: the customer already typed these to get a
        // price estimate, and re-asking staff for numbers the customer gave is
        // how they end up guessed at.
        countryId: optionalPositiveInt(b.countryId),
        valas: optionalPositiveNumber(b.valas),
        gram: optionalPositiveNumber(b.gram),
        estimatedPrice: optionalPositiveInt(b.estimatedPrice),
      },
      catalogueSql,
    )
    return NextResponse.json({ success: true }, { headers: corsHeaders() })
  } catch (err) {
    console.error("Failed to save custom catalogue request:", err)
    return NextResponse.json({ error: "Failed to save request" }, { status: 500, headers: corsHeaders() })
  }
}
