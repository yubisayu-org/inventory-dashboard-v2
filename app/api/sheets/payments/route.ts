import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole, isAdmin } from "@/lib/api"
import { getPaymentRows, addPayment } from "@/lib/db"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const rows = await getPaymentRows()
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch payments:", err)
    return NextResponse.json({ error: "Failed to fetch payments" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const { event, customer, amount, account, isChecked, payDate, remarks } = body

    if (!event || !customer) {
      return NextResponse.json({ error: "event and customer are required" }, { status: 400 })
    }

    const result = await addPayment({
      event: String(event),
      customer: String(customer),
      amount: Number(amount ?? 0),
      account: String(account ?? ""),
      // Admins cannot confirm payments — new payments are always unchecked.
      isChecked: isAdmin(session) ? false : Boolean(isChecked),
      payDate: String(payDate ?? ""),
      remarks: String(remarks ?? ""),
    })

    return NextResponse.json({ success: true, rowNumber: result.rowNumber })
  } catch (err) {
    console.error("Failed to add payment:", err)
    return NextResponse.json({ error: "Failed to add payment" }, { status: 500 })
  }
}
