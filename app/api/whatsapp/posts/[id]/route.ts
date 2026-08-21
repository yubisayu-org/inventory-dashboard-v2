import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole, requireOwner } from "@/lib/api"
import sql from "@/lib/db-pool"
import { toPricingMethod } from "@/lib/pricing"
import { getPost, listSlots, listClaims } from "@/lib/db/claims"
import { queueShelfPost } from "@/lib/db/outbox"
import { effectivePricingMethod } from "@/lib/whatsapp/pricing-method"
import { unorderedClaims } from "@/lib/whatsapp/naming"

type Params = { params: Promise<{ id: string }> }

/**
 * Everything one post knows.
 *
 * Open to any role: the shop screen reads this, and counting what is on a shelf
 * is not the same act as naming it. The write routes are where the two roles
 * part company.
 */
export async function GET(_req: Request, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const id = Number((await params).id)
  try {
    const post = await getPost(id)
    if (post === null) return NextResponse.json({ error: "Not found" }, { status: 404 })

    const [country] = post.countryId === null
      ? [null]
      : await sql`SELECT currency FROM countries WHERE id = ${post.countryId}`

    const [slots, claims, effective] = await Promise.all([
      listSlots(id),
      listClaims(id),
      effectivePricingMethod(post),
    ])

    // Which claims are on a named slot without an order of their own. A shelf
    // keeps taking claims after it is named, and those are invisible in the
    // accounts until somebody says so — the screen can only offer to fix what it
    // can see. A handful of slots per shelf, so a query each is cheap.
    const unordered = (
      await Promise.all(
        slots.map(async (slot) =>
          slot.productId === null ? [] : await unorderedClaims(slot.id),
        ),
      )
    ).flat()
    // Both are sent: pricingMethod says whether the post is following the
    // setting (null) or pinned, and effectivePricingMethod says what that
    // amounts to right now. A screen needs the first to render the control and
    // the second to name the option inside it.
    return NextResponse.json(
      {
        post: {
          ...post,
          effectivePricingMethod: effective,
          // What the price tag is written in, for the field that asks for it.
          currency: (country?.currency as string) ?? "",
        },
        slots,
        claims,
        unordered,
      },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to load WhatsApp post:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

/**
 * Announce a shelf that was uploaded without "Post to the WhatsApp group"
 * checked (or whose trip had no group bound yet at upload time). Same
 * queueShelfPost the upload route calls, so re-posting an already-sent
 * shelf is a harmless no-op (ON CONFLICT (post_id) DO NOTHING) — the 400
 * below just gives a clearer answer than silently doing nothing.
 *
 * Owner-only: this puts a message in the customer group. PATCH beside it is
 * open to any role, so the two no longer share a reason — announcing is the
 * outward-facing half.
 */
export async function POST(_req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const id = Number((await params).id)
  try {
    const post = await getPost(id)
    if (post === null) return NextResponse.json({ error: "Not found" }, { status: 404 })
    if (post.messageId) {
      return NextResponse.json({ error: "Already posted to the group" }, { status: 400 })
    }

    const queued = await queueShelfPost(id, post.event)
    if (!queued) {
      return NextResponse.json({ error: "No WhatsApp group bound to this event" }, { status: 400 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to queue shelf post:", err)
    return NextResponse.json({ error: "Failed to queue" }, { status: 500 })
  }
}

/**
 * Correct what a post will be priced with.
 *
 * A post follows the WhatsApp setting until one of its SKU is named, so most
 * shelves never need this: changing the setting moves all of them at once. It
 * exists for the shelf that is the exception — a different store, a one-off
 * arrangement — and null puts that shelf back under the setting.
 *
 * Open to any role, alongside naming: choosing the method and using it are
 * one act, and splitting them across two people helps nobody.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const id = Number((await params).id)
  try {
    const post = await getPost(id)
    if (post === null) return NextResponse.json({ error: "Not found" }, { status: 404 })

    const body = await req.json()

    // Null — or the empty string a <select> sends for its blank option — means
    // "follow the setting again", which is a different instruction from any
    // method and so cannot go through toPricingMethod.
    if (body.pricingMethod === null || body.pricingMethod === "") {
      await sql`
        UPDATE wa_posts SET pricing_method = NULL, updated_at = NOW() WHERE id = ${id}
      `
    } else if (typeof body.pricingMethod === "string") {
      await sql`
        UPDATE wa_posts SET pricing_method = ${toPricingMethod(body.pricingMethod)},
                            updated_at = NOW()
        WHERE id = ${id}
      `
    }
    if (typeof body.store === "string") {
      await sql`UPDATE wa_posts SET store = ${body.store.trim()}, updated_at = NOW() WHERE id = ${id}`
    }

    // Named SKUs keep the price they were created with, because their products
    // and orders already exist and repricing them here would change what
    // customers have been quoted.
    const [named] = await sql`
      SELECT COUNT(*)::int AS n FROM wa_slots WHERE post_id = ${id} AND product_id IS NOT NULL
    `
    return NextResponse.json({ success: true, alreadyNamed: named.n as number })
  } catch (err) {
    console.error("Failed to update post:", err)
    return NextResponse.json({ error: "Failed to update" }, { status: 500 })
  }
}
