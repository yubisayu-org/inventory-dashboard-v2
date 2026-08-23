import { NextRequest, NextResponse } from "next/server"
import { customerFromRequest } from "@/lib/catalogue-bearer"
import { corsHeaders, privateHeaders } from "@/lib/catalogue-cors"
import {
  getShippingPrefs,
  setShippingMode,
  setMergeGroup,
  setTempAddress,
  isShipMode,
  ShippingPrefError,
} from "@/lib/db/shipping-prefs"

// The customer's shipping choices for her own events. The customer id comes
// from the verified session and nowhere else; every guard — paid, not shipped,
// not half-shipped — lives in lib/db/shipping-prefs.ts and runs on the server,
// because a control the UI merely hides is not a rule.

const MAX_ADDRESS = 300

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET(req: NextRequest) {
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: privateHeaders() })
  }
  try {
    return NextResponse.json({ prefs: await getShippingPrefs(customer.id) }, { headers: privateHeaders() })
  } catch (err) {
    console.error("Failed to load shipping prefs:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500, headers: corsHeaders() })
  }
}

/** Refusals are the customer's business, so they come back as 409 with a reason. */
function refusal(err: unknown): NextResponse | null {
  if (!(err instanceof ShippingPrefError)) return null
  const messages: Record<string, string> = {
    unpaid: "Shipping choices open once this order is paid.",
    shipped: "This order has already shipped.",
    "part-shipped": "Part of this order has already shipped, so it cannot be held.",
    unknown: "That order could not be found.",
  }
  return NextResponse.json(
    { error: messages[err.message] ?? "That change isn't available.", reason: err.message },
    { status: 409, headers: privateHeaders() },
  )
}

export async function POST(req: NextRequest) {
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: privateHeaders() })
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() })
  }

  try {
    const action = String(body.action ?? "")

    if (action === "mode") {
      const event = String(body.event ?? "").trim()
      if (!event) return NextResponse.json({ error: "event is required" }, { status: 400, headers: corsHeaders() })
      if (!isShipMode(body.mode)) {
        return NextResponse.json({ error: "mode must be wait, split or hold" }, { status: 400, headers: corsHeaders() })
      }
      await setShippingMode(customer.id, event, body.mode)
    } else if (action === "merge") {
      const events = Array.isArray(body.events) ? body.events.map((e) => String(e)) : []
      await setMergeGroup(customer.id, events)
    } else if (action === "address") {
      const event = String(body.event ?? "").trim()
      const address = String(body.address ?? "")
      if (!event) return NextResponse.json({ error: "event is required" }, { status: 400, headers: corsHeaders() })
      if (address.length > MAX_ADDRESS) {
        return NextResponse.json(
          { error: `Address must be ${MAX_ADDRESS} characters or fewer` },
          { status: 400, headers: corsHeaders() },
        )
      }
      // The area is whatever the picker handed back. Capped like the address:
      // both are free-form as far as this endpoint is concerned, and a body
      // that arrives with a novel-length "area" is not a picker result.
      const areaId = String(body.areaId ?? "").slice(0, MAX_ADDRESS)
      const areaName = String(body.areaName ?? "").slice(0, MAX_ADDRESS)
      await setTempAddress(customer.id, event, { address, areaId, areaName })
    } else {
      return NextResponse.json({ error: "Unknown action" }, { status: 400, headers: corsHeaders() })
    }

    return NextResponse.json({ prefs: await getShippingPrefs(customer.id) }, { headers: privateHeaders() })
  } catch (err) {
    const refused = refusal(err)
    if (refused) return refused
    console.error("Failed to save shipping pref:", err)
    return NextResponse.json({ error: "Failed to save" }, { status: 500, headers: corsHeaders() })
  }
}
