import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { attachProductToSend } from "@/lib/db/wa-sends"

type Params = { params: Promise<{ id: string }> }

/** Tag a product onto the send and issue it the next free code for the
 *  send's event. Owner-only: this decides what will be advertised. */
export async function POST(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const sendId = Number((await params).id)
  if (!Number.isInteger(sendId) || sendId <= 0) {
    return NextResponse.json({ error: "Invalid send id" }, { status: 400 })
  }
  const { productId } = await req.json()
  if (typeof productId !== "number" || productId <= 0) {
    return NextResponse.json({ error: "productId must be a positive integer" }, { status: 400 })
  }

  try {
    const code = await attachProductToSend(sendId, productId)
    return NextResponse.json({ success: true, code })
  } catch (err) {
    // attachProductToSend throws plain Error("send not found") for a bad send id.
    // A bad product id is NOT a plain Error("product not found") though, despite
    // what the brief assumed — confirmed by hitting it live: the function inserts
    // into catalogue_post_products (product_id has an FK to products) BEFORE it
    // checks the product exists, so a bad product id surfaces as a raw Postgres
    // foreign-key-violation (code 23503) on catalogue_post_products_product_id_fkey,
    // not the friendly message. Both map to 404 here; anything else is a 500.
    const message = err instanceof Error ? err.message : "Failed to attach product"
    const pgError = err as { code?: string; constraint_name?: string }
    const isBadProduct =
      message === "product not found" ||
      (pgError.code === "23503" && pgError.constraint_name === "catalogue_post_products_product_id_fkey")
    const isBadSend = message === "send not found"

    if (isBadSend) return NextResponse.json({ error: "Send not found" }, { status: 404 })
    if (isBadProduct) return NextResponse.json({ error: "Product not found" }, { status: 404 })
    console.error("Failed to attach product to send:", err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
