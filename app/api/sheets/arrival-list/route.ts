import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getArrivalList, markProductArrived } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  const event = req.nextUrl.searchParams.get("event") ?? undefined

  try {
    const items = await getArrivalList(event)
    return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch arrival list:", err)
    return NextResponse.json({ error: "Failed to fetch arrival list" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  try {
    const { event, productId, quantityArrived } = await req.json()
    if (!event || !productId || typeof quantityArrived !== "number" || quantityArrived < 1) {
      return NextResponse.json(
        { error: "event, productId and quantityArrived are required" },
        { status: 400 },
      )
    }
    const result = await markProductArrived({
      event,
      productId: Number(productId),
      quantityArrived,
    })
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    console.error("Failed to mark orders as arrived:", err)
    return NextResponse.json({ error: "Failed to mark as arrived" }, { status: 500 })
  }
}
