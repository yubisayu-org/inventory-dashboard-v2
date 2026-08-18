import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import sql from "@/lib/db-pool"
import { normalizeCustomer } from "@/lib/db/helpers"
import { addClaim, getPost, listSlots } from "@/lib/db/claims"
import { recluster } from "@/lib/whatsapp/ingest"

type Params = { params: Promise<{ id: string }> }

/**
 * Record an order that did not come through the group.
 *
 * Customers message privately — "yang beruang size 95 ya kak" — and until now
 * that order had nowhere to go: every claim came from the worker, so a DM had
 * to be answered by asking her to send it again in the group.
 *
 * Stored as an ordinary claim, source "manual", so everything downstream is
 * unchanged: it clusters into a SKU, counts on the shopping list, is allocated
 * by paid priority when short, and becomes an order when the slot is named.
 *
 * Either an existing slot or a point on the photograph. A slot is the common
 * case — she asked for something somebody has already claimed — and its own
 * centre is used, so the claim lands in that cluster rather than beside it. A
 * point is for an item nobody has claimed yet, where clustering will make the
 * SKU.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const postId = Number((await params).id)
  try {
    const post = await getPost(postId)
    if (post === null) return NextResponse.json({ error: "Not found" }, { status: 404 })

    const body = await req.json()
    const customer = normalizeCustomer(String(body.customer ?? ""))
    const quantity = Number(body.quantity ?? 1)
    const note = String(body.note ?? "").trim()

    if (!customer) {
      return NextResponse.json({ error: "A customer is required" }, { status: 400 })
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      return NextResponse.json(
        { error: "quantity must be a whole number of 1 or more" },
        { status: 400 },
      )
    }

    // Refused rather than created: orders, invoices and the public invoice site
    // all key on the handle, and a typo would make a customer nobody can find.
    const [exists] = await sql`SELECT 1 FROM customers WHERE instagram_id = ${customer}`
    if (!exists) {
      return NextResponse.json({ error: `No customer called "${customer}"` }, { status: 400 })
    }

    let point: { x: number; y: number } | null = null
    if (body.slotId != null) {
      const slot = (await listSlots(postId)).find((s) => s.id === Number(body.slotId))
      if (!slot) return NextResponse.json({ error: "No such SKU" }, { status: 400 })
      point = slot.point
    } else if (body.point?.x != null && body.point?.y != null) {
      const x = Number(body.point.x)
      const y = Number(body.point.y)
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) {
        return NextResponse.json({ error: "That point is off the photo" }, { status: 400 })
      }
      point = { x, y }
    }

    const { id } = await addClaim({
      postId,
      // No number to record: she wrote privately, and the handle is what the
      // rest of the system keys on anyway.
      sender: "",
      customer,
      source: "manual",
      point,
      variantId: null,
      quantity,
      note,
      confidence: 1,
      state: "pending",
      messageId: "",
    })

    // Same as an ingest: the shelf's SKUs are recomputed, so the new claim
    // joins a cluster or makes one.
    await recluster(postId)

    return NextResponse.json({ id })
  } catch (err) {
    console.error("Failed to record a manual claim:", err)
    return NextResponse.json({ error: "Failed to save" }, { status: 500 })
  }
}
