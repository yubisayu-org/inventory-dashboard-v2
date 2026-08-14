import { NextRequest, NextResponse } from "next/server"
import { createCatalogueRequest, getCatalogueRequestsByHandle } from "@/lib/db"
import catalogueSql from "@/lib/db-catalogue-public"

const MAX_BODY_BYTES = 4 * 1024
const MAX_HANDLE_LEN = 30 // Instagram's own max handle length
const MAX_NOTE_LEN = 300

export async function GET(req: NextRequest) {
  const handle = req.nextUrl.searchParams.get("handle")?.trim()
  if (!handle) {
    return NextResponse.json({ error: "handle is required" }, { status: 400 })
  }
  try {
    const requests = await getCatalogueRequestsByHandle(handle, catalogueSql)
    return NextResponse.json({ requests }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to load catalogue requests:", err)
    return NextResponse.json({ error: "Failed to load requests" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const declaredLen = Number(req.headers.get("content-length") ?? 0)
  if (declaredLen > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 })
  }

  try {
    const body = await req.json()
    const customerHandle = String(body.customerHandle ?? "").trim()
    const productId = Number(body.productId)
    const qty = Number(body.qty)
    const note = String(body.note ?? "").trim()

    if (!customerHandle || customerHandle.length > MAX_HANDLE_LEN) {
      return NextResponse.json({ error: "A valid customerHandle is required" }, { status: 400 })
    }
    if (!Number.isInteger(productId) || productId < 1) {
      return NextResponse.json({ error: "productId must be a positive integer" }, { status: 400 })
    }
    if (!Number.isInteger(qty) || qty < 1) {
      return NextResponse.json({ error: "qty must be a positive integer" }, { status: 400 })
    }
    if (note.length > MAX_NOTE_LEN) {
      return NextResponse.json({ error: `note must be ${MAX_NOTE_LEN} characters or fewer` }, { status: 400 })
    }

    await createCatalogueRequest({ customerHandle, productId, qty, note }, catalogueSql)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to save catalogue request:", err)
    return NextResponse.json({ error: "Failed to save request" }, { status: 500 })
  }
}
