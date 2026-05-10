import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getShoppingList, markProductBought } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const event = req.nextUrl.searchParams.get("event") ?? undefined

  try {
    const items = await getShoppingList(event)
    return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch shopping list:", err)
    return NextResponse.json({ error: "Failed to fetch shopping list" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const { event, productId, productName, quantityBought } = await req.json()
    if (!event || !productId || !productName || typeof quantityBought !== "number" || quantityBought < 1) {
      return NextResponse.json({ error: "event, productId, productName and quantityBought are required" }, { status: 400 })
    }
    const result = await markProductBought({ event, productId: Number(productId), productName, quantityBought })
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    console.error("Failed to mark orders as bought:", err)
    return NextResponse.json({ error: "Failed to mark as bought" }, { status: 500 })
  }
}
