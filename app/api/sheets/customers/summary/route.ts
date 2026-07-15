import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getInvoiceForCustomer, getCustomerLedger } from "@/lib/db"

// Read-only aggregate for the customer detail drawer: invoices + the payment /
// adjustment / refund ledger for one customer, in a single round-trip.
export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const instagramId = req.nextUrl.searchParams.get("customer")?.trim()
  if (!instagramId) {
    return NextResponse.json({ error: "customer is required" }, { status: 400 })
  }

  try {
    const [invoices, ledger] = await Promise.all([
      getInvoiceForCustomer(instagramId),
      getCustomerLedger(instagramId),
    ])
    return NextResponse.json(
      { invoices, payments: ledger.payments, adjustments: ledger.adjustments, refunds: ledger.refunds },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to load customer summary:", err)
    return NextResponse.json({ error: "Failed to load customer summary" }, { status: 500 })
  }
}
