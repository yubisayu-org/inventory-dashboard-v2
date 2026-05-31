import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getCustomers, addCustomer, withActor } from "@/lib/db"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireRole(session)
  if (ownerError) return ownerError

  try {
    const rows = await getCustomers()
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch customers:", err)
    return NextResponse.json({ error: "Failed to fetch customers" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const ownerError = requireRole(session)
  if (ownerError) return ownerError

  try {
    const body = await req.json()
    const instagramId = String(body.instagramId ?? "").trim()
    if (!instagramId) {
      return NextResponse.json({ error: "instagramId is required" }, { status: 400 })
    }

    const result = await withActor(session.user.email, (tx) => addCustomer({
      instagramId,
      name: String(body.name ?? "").trim(),
      whatsapp: String(body.whatsapp ?? "").trim(),
      dataDiri: String(body.dataDiri ?? "").trim(),
      ekspedisi: String(body.ekspedisi ?? "").trim(),
      ongkosKirim: Number(body.ongkosKirim ?? 0),
      bankName: String(body.bankName ?? "").trim(),
      bankAccountNumber: String(body.bankAccountNumber ?? "").trim(),
      bankAccountHolder: String(body.bankAccountHolder ?? "").trim(),
    }, tx))

    return NextResponse.json({ success: true, id: result.id })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("duplicate") || msg.includes("unique")) {
      return NextResponse.json({ error: "A customer with that Instagram ID already exists" }, { status: 409 })
    }
    console.error("Failed to add customer:", err)
    return NextResponse.json({ error: "Failed to add customer" }, { status: 500 })
  }
}
