import { NextRequest, NextResponse } from "next/server"
import { customerFromRequest } from "@/lib/catalogue-bearer"
import { corsHeaders, privateHeaders } from "@/lib/catalogue-cors"
import catalogueSql from "@/lib/db-catalogue-public"
import {
  getCustomerPayments,
  getPayableBanks,
  submitCustomerPayment,
} from "@/lib/db/catalogue-payments"

// What the customer says she has transferred, and where she is asked to send
// it. Runs on catalogue_public, whose grant on `payments` deliberately omits
// is_checked — so nothing reachable from here can mark a payment verified.
//
// The handle comes from the verified session and never from the request: a
// handle in a body is a handle any stranger can type.

const MAX_BODY_BYTES = 2 * 1024

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET(req: NextRequest) {
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: privateHeaders() })
  }
  try {
    const [payments, banks] = await Promise.all([
      getCustomerPayments(customer.instagramId, catalogueSql),
      getPayableBanks(catalogueSql),
    ])
    return NextResponse.json({ payments, ...banks }, { headers: privateHeaders() })
  } catch (err) {
    console.error("Failed to load customer payments:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500, headers: corsHeaders() })
  }
}

export async function POST(req: NextRequest) {
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: privateHeaders() })
  }

  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: corsHeaders() })
  }

  let body: { event?: unknown; amount?: unknown; bank?: unknown; sender?: unknown }
  try {
    body = JSON.parse(raw || "{}")
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() })
  }

  const event = String(body.event ?? "")
  if (!event) {
    return NextResponse.json({ error: "event is required" }, { status: 400, headers: corsHeaders() })
  }

  try {
    const saved = await submitCustomerPayment({
      handle: customer.instagramId,
      event,
      amount: body.amount,
      bank: String(body.bank ?? ""),
      sender: String(body.sender ?? ""),
    }, catalogueSql)
    return NextResponse.json({ ok: true, ...saved }, { headers: privateHeaders() })
  } catch (err) {
    // Everything submitCustomerPayment throws is something she can act on —
    // a missing field, a nonsense amount, an event that is not hers — so the
    // message goes back rather than being swallowed into a 500.
    const message = err instanceof Error ? err.message : "Gagal menyimpan pembayaran"
    console.error("Failed to record customer payment:", err)
    return NextResponse.json({ error: message }, { status: 400, headers: corsHeaders() })
  }
}
