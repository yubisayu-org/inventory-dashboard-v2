import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { updatePayment, deletePayment } from "@/lib/db"

type Params = { params: Promise<{ row: string }> }

export async function PUT(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const { row } = await params
  const rowNumber = Number(row)
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    return NextResponse.json({ error: "Invalid row number" }, { status: 400 })
  }

  try {
    const body = await req.json()
    const { event, customer, amount, account, isChecked, payDate, remarks } = body

    if (!event || !customer) {
      return NextResponse.json({ error: "event and customer are required" }, { status: 400 })
    }

    await updatePayment(rowNumber, {
      event: String(event),
      customer: String(customer),
      amount: Number(amount ?? 0),
      account: String(account ?? ""),
      isChecked: Boolean(isChecked),
      payDate: String(payDate ?? ""),
      remarks: String(remarks ?? ""),
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update payment:", err)
    return NextResponse.json({ error: "Failed to update payment" }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const { row } = await params
  const rowNumber = Number(row)
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    return NextResponse.json({ error: "Invalid row number" }, { status: 400 })
  }

  try {
    await deletePayment(rowNumber)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to delete payment:", err)
    return NextResponse.json({ error: "Failed to delete payment" }, { status: 500 })
  }
}
