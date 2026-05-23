import { NextRequest, NextResponse } from "next/server"
import { getPublicInvoiceForCustomer } from "@/lib/db"
import publicSql from "@/lib/db-public"

// Public, no-login endpoint for the customer-facing recap site
// (yubisayu-invoice.netlify.app). Returns ONLY orders + payment status via the
// read-only `invoice_reader` connection — no name, WhatsApp, address, or bank
// data. Not matched by middleware (which only guards /dashboard), so it is
// intentionally reachable without a session.

const ALLOWED_ORIGIN = "https://yubisayu-invoice.netlify.app"

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET(req: NextRequest) {
  const customer = req.nextUrl.searchParams.get("customer")?.trim()
  if (!customer) {
    return NextResponse.json(
      { error: "customer is required" },
      { status: 400, headers: corsHeaders() },
    )
  }

  try {
    const data = await getPublicInvoiceForCustomer(customer, publicSql)
    return NextResponse.json(data, {
      headers: { ...corsHeaders(), "Cache-Control": "no-store" },
    })
  } catch (err) {
    console.error("Failed to load public invoice:", err)
    return NextResponse.json(
      { error: "Failed to load invoice" },
      { status: 500, headers: corsHeaders() },
    )
  }
}
