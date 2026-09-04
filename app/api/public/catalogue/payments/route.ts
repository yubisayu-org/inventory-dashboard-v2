import { NextRequest, NextResponse } from "next/server"
import { customerFromRequest } from "@/lib/catalogue-bearer"
import { corsHeaders, privateHeaders } from "@/lib/catalogue-cors"
import catalogueSql from "@/lib/db-catalogue-public"
import {
  DuplicateClaimError,
  getCustomerPayments,
  getPayableBanks,
  getQrisOffer,
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
    const [payments, banks, qris] = await Promise.all([
      getCustomerPayments(customer.instagramId, catalogueSql),
      getPayableBanks(catalogueSql),
      // Null whenever QRIS is not on offer — switched off, no QR uploaded, or
      // the year's ceiling reached. The reason never travels.
      getQrisOffer(catalogueSql),
    ])
    return NextResponse.json({ payments, ...banks, qris }, { headers: privateHeaders() })
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

  let body: {
    event?: unknown
    amount?: unknown
    bank?: unknown
    sender?: unknown
    confirmDuplicate?: unknown
  }
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
      confirmDuplicate: Boolean(body.confirmDuplicate),
    }, catalogueSql)
    return NextResponse.json({ ok: true, ...saved }, { headers: privateHeaders() })
  } catch (err) {
    // A lookalike is not a refusal: she is told what the shop already has and
    // may send it again. The sheet needs the figures to say so, and needs to
    // know this is the one failure that a second press gets past.
    if (err instanceof DuplicateClaimError) {
      const { amount, payDate, reportedBy } = err.duplicate
      return NextResponse.json(
        { error: err.message, duplicate: { amount, payDate, mine: reportedBy === "customer" } },
        { status: 409, headers: corsHeaders() },
      )
    }

    // Everything else submitCustomerPayment throws is something she can act on
    // — a missing field, a nonsense amount, an event that is not hers — so the
    // message goes back rather than being swallowed into a 500.
    const message = err instanceof Error ? err.message : "Gagal menyimpan pembayaran"
    console.error("Failed to record customer payment:", err)
    return NextResponse.json({ error: message }, { status: 400, headers: corsHeaders() })
  }
}
