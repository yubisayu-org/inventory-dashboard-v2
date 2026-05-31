import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { updateRefund, executeRefund, deleteRefund, applyRefundAsCredit, undoRefundCredit, withActor } from "@/lib/db"
import type { RefundStatus } from "@/lib/db"

const VALID_STATUSES: RefundStatus[] = [
  "pending", "awaiting_bank_info", "ready_to_refund", "refunded", "applied_to_next_order", "cancelled",
]

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const { id } = await params
  const refundId = Number(id)
  if (!refundId) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  try {
    const body = await req.json()
    const { action, ...data } = body

    if (action === "execute") {
      const { transferReference } = data
      if (!transferReference?.trim()) {
        return NextResponse.json({ error: "transferReference is required" }, { status: 400 })
      }
      await executeRefund(refundId, transferReference.trim(), session.user.email)
      return NextResponse.json({ success: true })
    }

    if (action === "apply_credit") {
      const { targetEvent } = data
      if (!targetEvent?.trim()) {
        return NextResponse.json({ error: "targetEvent is required" }, { status: 400 })
      }
      await applyRefundAsCredit(refundId, targetEvent.trim(), session.user.email)
      return NextResponse.json({ success: true })
    }

    if (action === "undo_credit") {
      await undoRefundCredit(refundId, session.user.email)
      return NextResponse.json({ success: true })
    }

    if (data.status && !VALID_STATUSES.includes(data.status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 })
    }

    await withActor(session.user.email, (tx) => updateRefund(refundId, {
      status: data.status,
      refundAmount: data.refundAmount !== undefined ? Number(data.refundAmount) : undefined,
      bankName: data.bankName,
      bankAccountNumber: data.bankAccountNumber,
      bankAccountHolder: data.bankAccountHolder,
      transferReference: data.transferReference,
      note: data.note,
    }, tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update refund:", err)
    const msg = err instanceof Error ? err.message : "Failed to update"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const { id } = await params
  const refundId = Number(id)
  if (!refundId) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  try {
    await withActor(session.user.email, (tx) => deleteRefund(refundId, tx))
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to delete refund:", err)
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 })
  }
}
