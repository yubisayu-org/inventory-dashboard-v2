import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { tsToString } from "./helpers"
import { toPricingMethod, type PricingMethod } from "@/lib/pricing"
import type { Point } from "@/lib/claims"

export interface WaPost {
  id: number
  event: string
  imagePath: string
  imageWidth: number
  imageHeight: number
  store: string
  countryId: number | null
  pricingMethod: PricingMethod
  note: string
  safeHues: number[]
  createdAt: string
}

export type ClaimSource = "ink" | "crop" | "repost" | "text" | "manual"
export type ClaimState = "pending" | "assigned" | "review" | "rejected"

export interface WaClaim {
  id: number
  postId: number
  sender: string
  customer: string | null
  source: ClaimSource
  point: Point | null
  variantId: string | null
  quantity: number
  note: string
  confidence: number
  state: ClaimState
  messageId: string
  slotId: number | null
  createdAt: string
}

export interface WaSlot {
  id: number
  postId: number
  point: Point | null
  variantId: string | null
  /** Sum of the quantities of the claims attached to this slot. Derived. */
  claimed: number
  bought: number
  productId: number | null
}

export async function createPost(input: {
  event: string
  imagePath: string
  imageWidth: number
  imageHeight: number
  store: string
  countryId: number | null
  pricingMethod: PricingMethod
  note: string
  safeHues: number[]
}, db: DBExecutor = sql): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO wa_posts (event, image_path, image_width, image_height, store,
      country_id, pricing_method, note, safe_hues)
    VALUES (${input.event}, ${input.imagePath}, ${input.imageWidth},
      ${input.imageHeight}, ${input.store}, ${input.countryId},
      ${input.pricingMethod}, ${input.note}, ${input.safeHues})
    RETURNING id
  `
  return { id: row.id }
}

function mapPost(r: Record<string, unknown>): WaPost {
  return {
    id: r.id as number,
    event: r.event as string,
    imagePath: r.image_path as string,
    imageWidth: (r.image_width as number) ?? 0,
    imageHeight: (r.image_height as number) ?? 0,
    store: (r.store as string) ?? "",
    countryId: (r.country_id as number | null) ?? null,
    pricingMethod: toPricingMethod(r.pricing_method),
    note: (r.note as string) ?? "",
    safeHues: ((r.safe_hues as number[]) ?? []).map(Number),
    createdAt: tsToString(r.created_at as Date | null),
  }
}

export async function getPost(id: number): Promise<WaPost | null> {
  const [row] = await sql`SELECT * FROM wa_posts WHERE id = ${id}`
  return row ? mapPost(row) : null
}

/**
 * One page of posts. Under 100 per event, but they accumulate across events,
 * so this paginates like every other list in the dashboard.
 */
export async function listPosts(opts: {
  event?: string
  search?: string
  page: number
  pageSize: number
}): Promise<{ rows: WaPost[]; totalCount: number }> {
  const offset = (opts.page - 1) * opts.pageSize
  const event = opts.event ?? null
  const search = opts.search ? `%${opts.search.toLowerCase()}%` : null

  const rows = await sql`
    SELECT * FROM wa_posts
    WHERE (${event}::text IS NULL OR event = ${event})
      AND (${search}::text IS NULL OR lower(store) LIKE ${search} OR lower(note) LIKE ${search})
    ORDER BY id DESC
    LIMIT ${opts.pageSize} OFFSET ${offset}
  `
  const [{ total }] = await sql`
    SELECT COUNT(*)::int AS total FROM wa_posts
    WHERE (${event}::text IS NULL OR event = ${event})
      AND (${search}::text IS NULL OR lower(store) LIKE ${search} OR lower(note) LIKE ${search})
  `
  return { rows: rows.map(mapPost), totalCount: total }
}

export async function addClaim(input: {
  postId: number
  sender: string
  customer: string | null
  source: ClaimSource
  point: Point | null
  variantId: string | null
  quantity: number
  note: string
  confidence: number
  state: ClaimState
  messageId: string
}, db: DBExecutor = sql): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO wa_claims (post_id, sender, customer, source, point_x, point_y,
      variant_id, quantity, note, confidence, state, message_id)
    VALUES (${input.postId}, ${input.sender}, ${input.customer}, ${input.source},
      ${input.point?.x ?? null}, ${input.point?.y ?? null}, ${input.variantId},
      ${input.quantity}, ${input.note}, ${input.confidence}, ${input.state},
      ${input.messageId})
    RETURNING id
  `
  return { id: row.id }
}

function mapClaim(r: Record<string, unknown>): WaClaim {
  const x = r.point_x as number | null
  const y = r.point_y as number | null
  return {
    id: r.id as number,
    postId: r.post_id as number,
    sender: (r.sender as string) ?? "",
    customer: (r.customer as string | null) ?? null,
    source: r.source as ClaimSource,
    point: x === null || y === null ? null : { x: Number(x), y: Number(y) },
    variantId: (r.variant_id as string | null) ?? null,
    quantity: (r.quantity as number) ?? 1,
    note: (r.note as string) ?? "",
    confidence: Number(r.confidence ?? 1),
    state: r.state as ClaimState,
    messageId: (r.message_id as string) ?? "",
    slotId: (r.slot_id as number | null) ?? null,
    createdAt: tsToString(r.created_at as Date | null),
  }
}

export async function listClaims(postId: number): Promise<WaClaim[]> {
  const rows = await sql`SELECT * FROM wa_claims WHERE post_id = ${postId} ORDER BY id ASC`
  return rows.map(mapClaim)
}

/**
 * Replace a post's slots with a freshly clustered set.
 *
 * Clustering is recomputed whenever a claim arrives, so this runs often. What
 * it must NOT do is discard the two things a slot knows that clustering cannot
 * recompute — the shop tally and the product it was named as. Those are matched
 * back by position, because the owner is looking at a photo and a slot that
 * moved half a percent is the same slot to them.
 */
export async function setSlots(
  postId: number,
  slots: { point: Point | null; variantId: string | null; claimIds: number[] }[],
): Promise<void> {
  await sql.begin(async (tx) => {
    const existing = await tx`SELECT * FROM wa_slots WHERE post_id = ${postId}`

    // Carry forward bought/product by nearest previous slot centre. A variant
    // slot matches by id instead, since it has no position.
    const carried = slots.map((slot) => {
      const previous = existing.find((e) => {
        if (slot.variantId !== null) return e.variant_id === slot.variantId
        if (slot.point === null || e.point_x === null) return false
        return Math.hypot(Number(e.point_x) - slot.point.x, Number(e.point_y) - slot.point.y) < 0.03
      })
      return {
        ...slot,
        bought: (previous?.bought as number) ?? 0,
        productId: (previous?.product_id as number | null) ?? null,
      }
    })

    await tx`UPDATE wa_claims SET slot_id = NULL WHERE post_id = ${postId}`
    await tx`DELETE FROM wa_slots WHERE post_id = ${postId}`

    for (const slot of carried) {
      const [row] = await tx`
        INSERT INTO wa_slots (post_id, point_x, point_y, variant_id, bought, product_id)
        VALUES (${postId}, ${slot.point?.x ?? null}, ${slot.point?.y ?? null},
          ${slot.variantId}, ${slot.bought}, ${slot.productId})
        RETURNING id
      `
      if (slot.claimIds.length > 0) {
        await tx`
          UPDATE wa_claims SET slot_id = ${row.id}, state = 'assigned', updated_at = NOW()
          WHERE id IN ${tx(slot.claimIds)}
        `
      }
    }
  })
}

export async function listSlots(postId: number): Promise<WaSlot[]> {
  const rows = await sql`
    SELECT s.*, COALESCE(SUM(c.quantity), 0)::int AS claimed
    FROM wa_slots s
    LEFT JOIN wa_claims c ON c.slot_id = s.id AND c.state <> 'rejected'
    WHERE s.post_id = ${postId}
    GROUP BY s.id
    ORDER BY s.id ASC
  `
  return rows.map((r) => {
    const x = r.point_x as number | null
    const y = r.point_y as number | null
    return {
      id: r.id as number,
      postId: r.post_id as number,
      point: x === null || y === null ? null : { x: Number(x), y: Number(y) },
      variantId: (r.variant_id as string | null) ?? null,
      claimed: (r.claimed as number) ?? 0,
      bought: (r.bought as number) ?? 0,
      productId: (r.product_id as number | null) ?? null,
    }
  })
}

/** The shop tally. Independent of orders, which may not exist yet. */
export async function setSlotBought(
  slotId: number,
  bought: number,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE wa_slots SET bought = ${bought}, updated_at = NOW() WHERE id = ${slotId}
  `
}
