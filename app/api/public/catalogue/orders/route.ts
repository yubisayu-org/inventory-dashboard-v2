import { NextRequest, NextResponse } from "next/server"
import { customerFromRequest } from "@/lib/catalogue-bearer"
import { corsHeaders, privateHeaders } from "@/lib/catalogue-cors"
import { getCustomerBalance } from "@/lib/db/catalogue-orders"
import { getPublicInvoiceForCustomer } from "@/lib/db"
import catalogueSql from "@/lib/db-catalogue-public"
import publicSql from "@/lib/db-public"

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET(req: NextRequest) {
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: privateHeaders() })
  }
  try {
    // Both handles come from the verified session, never from the request.
    //
    // The per-event invoice is the same query the public recap site uses, on
    // the same PII-blind `invoice_reader` role — it returns orders, payment
    // status and tracking, and reads ongkos_kirim without name, WhatsApp,
    // address or bank columns being selectable at all. Reusing it means the
    // catalogue shows the invoice the shop shows, rather than a second
    // rendering of the same numbers that can drift from it.
    const [invoice, balance] = await Promise.all([
      getPublicInvoiceForCustomer(customer.instagramId, publicSql),
      getCustomerBalance(customer.instagramId, catalogueSql),
    ])
    return NextResponse.json(
      { events: invoice.events, balance },
      { headers: privateHeaders() },
    )
  } catch (err) {
    console.error("Failed to load customer orders:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500, headers: corsHeaders() })
  }
}
