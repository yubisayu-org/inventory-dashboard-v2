import { NextRequest, NextResponse } from "next/server"
import { customerFromRequest } from "@/lib/catalogue-bearer"
import { corsHeaders, privateHeaders } from "@/lib/catalogue-cors"
import { previewRedirect } from "@/lib/db/redirect-ongkir"

// What sending this parcel to another area would cost her, asked while she is
// still choosing it. Read-only: nothing is written and nothing is charged
// here — saving the address does that, and it asks the courier again rather
// than trusting a figure that has been through a browser.

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function POST(req: NextRequest) {
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: privateHeaders() })
  }

  let body: { event?: unknown; areaId?: unknown }
  try {
    body = JSON.parse((await req.text()) || "{}")
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() })
  }

  const event = String(body.event ?? "").trim()
  const areaId = String(body.areaId ?? "").trim()
  if (!event || !areaId) {
    return NextResponse.json(
      { error: "event and areaId are required" },
      { status: 400, headers: corsHeaders() },
    )
  }

  try {
    const quote = await previewRedirect(customer.id, event, areaId)
    // No quote is not an error: a handful of areas have no published rate, and
    // she is told that plainly rather than shown a figure nobody stands behind.
    return NextResponse.json({ quote }, { headers: privateHeaders() })
  } catch (err) {
    console.error("Failed to quote a redirect:", err)
    return NextResponse.json({ error: "Failed to quote" }, { status: 500, headers: corsHeaders() })
  }
}
