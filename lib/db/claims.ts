import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { tsToString } from "./helpers"
import { toPricingMethod, type PricingMethod } from "@/lib/pricing"
import { fetchPaidStatusMap, compareOrderPriority } from "./shopping-list"
import { allocateFifo } from "@/lib/fifo-fill"
import type { Point } from "@/lib/claims"

export interface WaPost {
  id: number
  event: string
  imagePath: string
  imageWidth: number
  imageHeight: number
  store: string
  countryId: number | null
  /**
   * The method this shelf is priced with, or null to follow the WhatsApp
   * setting. Null is resolved by effectivePricingMethod and frozen to a concrete
   * value the first time a SKU on the post is named — see migration 068.
   */
  pricingMethod: PricingMethod | null
  note: string
  safeHues: number[]
  /** The WhatsApp message this post was sent as. Empty for dashboard uploads. */
  messageId: string
  groupJid: string
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
  /** How many of this claim were actually bought. The slot's total is the sum. */
  obtained: number
  note: string
  /**
   * The size agreed after the fact, when the one asked for was not there.
   * Null means the note still speaks for itself, which is the normal case.
   */
  size: string | null
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
  /** Size this slot is for. Empty means nobody said one — a real state, not a gap. */
  size: string
  /** Working name. Not a product: naming is a separate, heavier act. */
  label: string
  /** Sum of the quantities of the claims attached to this slot. Derived. */
  claimed: number
  /** Sum of what those claims obtained. Also derived — see migration 064. */
  bought: number
  productId: number | null
  /** Name and price of the product this slot was named as, once it has been.
   *  Carried here so a screen showing slots never has to fetch products too. */
  productName: string | null
  productPrice: number | null
}

export async function createPost(input: {
  event: string
  imagePath: string
  imageWidth: number
  imageHeight: number
  store: string
  countryId: number | null
  /** Null follows the WhatsApp default until the post is named. */
  pricingMethod: PricingMethod | null
  note: string
  safeHues: number[]
  messageId?: string
  groupJid?: string
}, db: DBExecutor = sql): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO wa_posts (event, image_path, image_width, image_height, store,
      country_id, pricing_method, note, safe_hues, message_id, group_jid)
    VALUES (${input.event}, ${input.imagePath}, ${input.imageWidth},
      ${input.imageHeight}, ${input.store}, ${input.countryId},
      ${input.pricingMethod}, ${input.note}, ${input.safeHues},
      ${input.messageId ?? ""}, ${input.groupJid ?? ""})
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
    // Null is a real answer here — "ask the setting" — so it survives rather
    // than being narrowed to overseas the way a bad string is.
    pricingMethod: r.pricing_method === null ? null : toPricingMethod(r.pricing_method),
    note: (r.note as string) ?? "",
    safeHues: ((r.safe_hues as number[]) ?? []).map(Number),
    messageId: (r.message_id as string) ?? "",
    groupJid: (r.group_jid as string) ?? "",
    createdAt: tsToString(r.created_at as Date | null),
  }
}

export async function getPost(id: number): Promise<WaPost | null> {
  const [row] = await sql`SELECT * FROM wa_posts WHERE id = ${id}`
  return row ? mapPost(row) : null
}

/**
 * The post a reply is quoting.
 *
 * Scoped to the group as well as the message id: ids are unique per chat, not
 * globally, and two groups running two trips must not resolve to each other's
 * shelves.
 */
export async function findPostByMessage(
  groupJid: string,
  messageId: string,
): Promise<WaPost | null> {
  if (!messageId) return null
  const [row] = await sql`
    SELECT * FROM wa_posts
    WHERE group_jid = ${groupJid} AND message_id = ${messageId}
  `
  return row ? mapPost(row) : null
}

/**
 * The group's most recent shelves, newest first.
 *
 * Used to work out which shelf a customer marked when they did not reply to it.
 * Bounded because the answer is always recent: people claim on what is on
 * screen, not on last week's shop.
 */
export async function listRecentPosts(groupJid: string, limit = 8): Promise<WaPost[]> {
  const rows = await sql`
    SELECT * FROM wa_posts
    WHERE group_jid = ${groupJid}
    ORDER BY id DESC
    LIMIT ${limit}
  `
  return rows.map(mapPost)
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
    obtained: (r.obtained as number) ?? 0,
    note: (r.note as string) ?? "",
    size: (r.size as string | null) ?? null,
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
 * it must NOT do is discard the three things a slot knows that clustering
 * cannot recompute — the working name, the product it was named as, and (via
 * its claims) what was bought. The first two are matched back by position AND
 * size, because two sizes of one item sit at the same point on the photograph
 * and position alone would let their identities swap.
 *
 * What was bought needs no carrying: it lives on the claims, which are not
 * touched here beyond being re-pointed.
 */
export async function setSlots(
  postId: number,
  slots: { point: Point | null; variantId: string | null; size: string; claimIds: number[] }[],
): Promise<void> {
  await sql.begin(async (tx) => {
    const existing = await tx`SELECT * FROM wa_slots WHERE post_id = ${postId}`

    const carried = slots.map((slot) => {
      const previous = existing.find((e) => {
        if ((e.size as string) !== slot.size) return false
        if (slot.variantId !== null) return e.variant_id === slot.variantId
        if (slot.point === null || e.point_x === null) return false
        return Math.hypot(Number(e.point_x) - slot.point.x, Number(e.point_y) - slot.point.y) < 0.03
      })
      return {
        ...slot,
        label: (previous?.label as string) ?? "",
        productId: (previous?.product_id as number | null) ?? null,
      }
    })

    await tx`UPDATE wa_claims SET slot_id = NULL WHERE post_id = ${postId}`
    await tx`DELETE FROM wa_slots WHERE post_id = ${postId}`

    for (const slot of carried) {
      const [row] = await tx`
        INSERT INTO wa_slots (post_id, point_x, point_y, variant_id, size, label, product_id)
        VALUES (${postId}, ${slot.point?.x ?? null}, ${slot.point?.y ?? null},
          ${slot.variantId}, ${slot.size}, ${slot.label}, ${slot.productId})
        RETURNING id
      `
      if (slot.claimIds.length > 0) {
        await tx`
          UPDATE wa_claims
          SET slot_id = ${row.id},
              -- Only a pending claim advances. A claim in review was put there
              -- because a human has to look at it — a crop that barely matched,
              -- a sender nobody recognises — and clustering runs on every new
              -- claim, so promoting unconditionally emptied the review queue
              -- moments after anything landed in it.
              state = CASE WHEN state = 'pending' THEN 'assigned' ELSE state END,
              updated_at = NOW()
          WHERE id IN ${tx(slot.claimIds)}
        `
      }
    }
  })
}

export async function listSlots(postId: number): Promise<WaSlot[]> {
  const rows = await sql`
    SELECT s.*,
           COALESCE(SUM(c.quantity), 0)::int AS claimed,
           COALESCE(SUM(c.obtained), 0)::int AS bought,
           p.name AS product_name,
           p.price AS product_price
    FROM wa_slots s
    LEFT JOIN wa_claims c ON c.slot_id = s.id AND c.state <> 'rejected'
    LEFT JOIN products p ON p.id = s.product_id
    WHERE s.post_id = ${postId}
    GROUP BY s.id, p.name, p.price
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
      size: (r.size as string) ?? "",
      label: (r.label as string) ?? "",
      claimed: (r.claimed as number) ?? 0,
      bought: (r.bought as number) ?? 0,
      productId: (r.product_id as number | null) ?? null,
      productName: (r.product_name as string | null) ?? null,
      productPrice: r.product_price != null ? Number(r.product_price) : null,
    }
  })
}

/** The working name, typed once in the shop. Creates nothing. */
export async function setSlotLabel(
  slotId: number,
  label: string,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE wa_slots SET label = ${label.trim()}, updated_at = NOW() WHERE id = ${slotId}
  `
}

/**
 * Push what the claims say onto the orders naming created for them.
 *
 * Naming copies obtained onto unit_buy once, at the moment it creates the
 * orders. Counting does not stop there: a shelf is often named at the hotel and
 * then revisited — a second store, a restock, a size that turned up later — and
 * every unit counted after naming used to land on wa_claims and go no further,
 * leaving the shopping list asking for something already in the suitcase.
 *
 * A no-op for an unnamed slot, which has no orders yet; naming will read the
 * claims itself when it makes them.
 *
 * Claims and orders are paired by (customer, quantity) in id order rather than
 * by a stored link, because appendOrders returns nothing to store. Ranking both
 * sides keeps two identical claims from the same customer — the same person
 * asking twice for one unit — pointing at one order each instead of both
 * pointing at the first.
 *
 * Zero is written as NULL, not 0, matching what naming writes for a claim that
 * got nothing: the shopping list reads both as "still to buy", but dispatch
 * treats NOT NULL as "there is something to send".
 */
export async function syncOrdersToClaims(slotId: number, db: DBExecutor = sql): Promise<void> {
  const [slot] = await db`
    SELECT s.product_id, p.event
    FROM wa_slots s JOIN wa_posts p ON p.id = s.post_id
    WHERE s.id = ${slotId}
  `
  if (!slot || slot.product_id === null) return

  await db`
    WITH claim_rank AS (
      SELECT id, customer, quantity, obtained,
             row_number() OVER (PARTITION BY customer, quantity ORDER BY id) AS rn
      FROM wa_claims
      WHERE slot_id = ${slotId} AND state <> 'rejected' AND customer IS NOT NULL
    ), order_rank AS (
      SELECT id, customer, unit,
             row_number() OVER (PARTITION BY customer, unit ORDER BY id) AS rn
      FROM orders
      WHERE product_id = ${slot.product_id} AND event = ${slot.event}
    )
    UPDATE orders o
    SET unit_buy = NULLIF(c.obtained, 0), updated_at = NOW()
    FROM claim_rank c
    JOIN order_rank r ON r.customer = c.customer AND r.unit = c.quantity AND r.rn = c.rn
    WHERE o.id = r.id AND o.unit_buy IS DISTINCT FROM NULLIF(c.obtained, 0)
  `
}

/** One claim's outcome — what the owner's tick in the group means. */
export async function markClaimObtained(
  claimId: number,
  obtained: number,
  db: DBExecutor = sql,
): Promise<void> {
  const [claim] = await db`
    UPDATE wa_claims SET obtained = ${Math.max(0, Math.trunc(obtained))}, updated_at = NOW()
    WHERE id = ${claimId}
    RETURNING slot_id
  `
  if (claim?.slot_id != null) await syncOrdersToClaims(claim.slot_id as number, db)
}

/**
 * The stepper: "I got N of this SKU", without saying whose.
 *
 * Spends N across the slot's claims in the order the rest of the app already
 * settles a shortage — paid, then partly paid, then unpaid, then whoever asked
 * first. Claims that get nothing are reset to zero, because N is a statement
 * about the whole slot rather than an increment.
 *
 * The owner's tick on a single message writes the same column directly. Both
 * roads lead to wa_claims.obtained, so the shopping list cannot show one number
 * while the orders behind it say another.
 */
export async function setSlotBought(slotId: number, bought: number): Promise<void> {
  const [slot] = await sql`
    SELECT s.id, p.event
    FROM wa_slots s JOIN wa_posts p ON p.id = s.post_id
    WHERE s.id = ${slotId}
  `
  if (!slot) throw new Error(`no such slot: ${slotId}`)

  const rows = await sql`
    SELECT id, customer, quantity FROM wa_claims
    WHERE slot_id = ${slotId} AND state <> 'rejected'
    ORDER BY id ASC
  `
  const event = slot.event as string
  const claims = rows.map((r) => ({
    id: r.id as number,
    // An unresolved sender has no payment history to rank on, so they sort as
    // unpaid — which is where an unknown belongs when units are short.
    customer: (r.customer as string | null) ?? "",
    quantity: r.quantity as number,
  }))

  const statusMap = await fetchPaidStatusMap([event])
  claims.sort(compareOrderPriority(event, statusMap))

  const { allocations } = allocateFifo(claims, (c) => c.quantity, Math.max(0, Math.trunc(bought)))
  const given = new Map(allocations.map((a) => [a.item.id, a.allocated]))

  await sql.begin(async (tx) => {
    for (const claim of claims) {
      await tx`
        UPDATE wa_claims SET obtained = ${given.get(claim.id) ?? 0}, updated_at = NOW()
        WHERE id = ${claim.id}
      `
    }
    // In the same transaction, so the orders can never be left disagreeing with
    // the claims they were built from.
    await syncOrdersToClaims(slotId, tx)
  })
}
