import postgres from "postgres"
import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { withActor } from "./actor"
import { appendOrders } from "./orders"
import { normalizeId } from "./helpers"
import type { CatalogueRequest } from "./types"
import { calcAbroadPrice, calcKursPrice } from "../pricing"
import { resolveTieredKurs } from "../kurs-tiers"
import { getCountryRate, getTierKursInputs } from "./catalog"
import { queueText, queueReaction } from "./replies"
import { linkSenderToCustomer } from "../whatsapp/identity"
import { getProductDefaults } from "./settings"

type Candidate = { id: number; code: string; productId: number; productName: string; price: number }

function toRequest(r: Record<string, unknown>, candidateMap?: Map<number, Candidate>): CatalogueRequest {
  const candidateIds = (r.candidate_send_code_ids as number[] | null | undefined) ?? null
  return {
    id: r.id as number,
    customerHandle: r.customer_handle as string,
    productId: (r.product_id as number | null) ?? null,
    productName: (r.product_name as string | null) ?? null,
    description: r.description as string,
    referenceImageUrl: (r.reference_image_url as string | null) ?? null,
    qty: r.qty as number,
    note: r.note as string,
    status: r.status as CatalogueRequest["status"],
    staffNote: r.staff_note as string,
    convertedOrderId: (r.converted_order_id as number | null) ?? null,
    createdAt: (r.created_at as Date).toISOString(),
    countryId: (r.country_id as number | null) ?? null,
    countryName: (r.country_name as string | null) ?? null,
    // valas/gram are NUMERIC — postgres-js returns them as strings when
    // set, same coercion needed as everywhere else NUMERIC is read.
    valas: r.valas != null ? Number(r.valas) : null,
    gram: r.gram != null ? Number(r.gram) : null,
    estimatedPrice: (r.estimated_price as number | null) ?? null,
    // Two explicit-column callers below don't SELECT this — undefined falls
    // back to the column's own DB default ('overseas'), same convention as
    // every other field only getCatalogueRequests actually populates.
    proposedPricingMethod: (r.proposed_pricing_method as "overseas" | "tier_kurs" | undefined) ?? "overseas",
    proposedProfitPct: (r.proposed_profit_pct as number | null) ?? null,
    proposedOperationalFee: (r.proposed_operational_fee as number | null) ?? null,
    proposedPackingFee: (r.proposed_packing_fee as number | null) ?? null,
    proposedTieredKurs: (r.proposed_tiered_kurs as number | null) ?? null,
    proposedName: (r.proposed_name as string | null) ?? null,
    postId: (r.post_id as number | null) ?? null,
    defaultEvent: (r.default_event as string | null) ?? null,
    // The two explicit-column callers below (getCatalogueRequestsByHandle,
    // getCatalogueRequests) don't SELECT these — undefined there falls back
    // to the same values an actual 'catalogue'-sourced row would carry.
    source: (r.source as CatalogueRequest["source"] | undefined) ?? "catalogue",
    sendId: (r.send_id as number | null | undefined) ?? null,
    sendCodeId: (r.send_code_id as number | null | undefined) ?? null,
    sender: (r.sender as string | undefined) ?? "",
    messageId: (r.message_id as string | undefined) ?? "",
    botMessageId: (r.bot_message_id as string | undefined) ?? "",
    candidateSendCodeIds: candidateIds,
    // The two explicit-column callers below don't SELECT resolved_code/
    // resolved_code_send_id either — undefined falls back to null, same
    // convention as the WhatsApp fields above.
    resolvedCode: (r.resolved_code as string | null | undefined) ?? null,
    resolvedCodeSendId: (r.resolved_code_send_id as number | null | undefined) ?? null,
    // Only getCatalogueRequests SELECTs this (via the wa_sends join above);
    // the two explicit-column callers fall back to null, same convention as
    // every other WhatsApp-only field on this row.
    resolvedEvent: (r.resolved_event as string | null | undefined) ?? null,
    // Only getCatalogueRequests passes a candidateMap (built from a batched
    // lookup across all rows); the two explicit-column callers above have no
    // map and no candidate_send_code_ids column, so candidates stays null.
    candidates: candidateIds && candidateIds.length > 0 && candidateMap
      ? candidateIds.map((cid) => candidateMap.get(cid)).filter((c): c is Candidate => c != null)
      : null,
  }
}

/** Public path: submit one request — either a Fix request (productId set,
 *  description/referenceImageUrl omitted) or a custom request (productId
 *  null, description required — enforced by the DB check constraint, not
 *  re-validated here since the calling route already validates it).
 *  `db` must be the scoped `catalogue_public` connection — no default.
 *  Stores the handle normalized (bare lowercase, no "@"), matching every
 *  other customer handle write in this codebase. */
export async function createCatalogueRequest(
  data: {
    customerHandle: string
    productId: number | null
    qty: number
    note: string
    description?: string
    referenceImageUrl?: string | null
    postId?: number | null
    /** What the customer's own live estimate showed at submit time — a
     *  custom request's country/valas/gram/estimatedPrice, carried through
     *  instead of dropped at the browser (migration 088). Frozen, not
     *  recomputed: the propose-price flow can show this beside a fresh
     *  calculation for comparison, since rates may have moved since. */
    countryId?: number | null
    valas?: number | null
    gram?: number | null
    estimatedPrice?: number | null
  },
  db: postgres.Sql,
): Promise<void> {
  await db`
    INSERT INTO catalogue_requests
      (customer_handle, product_id, qty, note, description, reference_image_url, post_id,
       country_id, valas, gram, estimated_price)
    VALUES (
      ${normalizeId(data.customerHandle)},
      ${data.productId},
      ${data.qty},
      ${data.note},
      ${data.description ?? ""},
      ${data.referenceImageUrl ?? null},
      ${data.postId ?? null},
      ${data.countryId ?? null},
      ${data.valas ?? null},
      ${data.gram ?? null},
      ${data.estimatedPrice ?? null}
    )
  `
}

/** Public path: a handle's own requests. `db` must be the scoped
 *  `catalogue_public` connection — no default. LEFT JOIN (not JOIN) because
 *  a custom request has no product row to join to. */
export async function getCatalogueRequestsByHandle(
  handle: string,
  db: postgres.Sql,
): Promise<CatalogueRequest[]> {
  const rows = await db`
    SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
           r.description, r.reference_image_url,
           r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at,
           r.country_id, c.name AS country_name, r.valas, r.gram, r.estimated_price
    FROM catalogue_requests r
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN countries c ON c.id = r.country_id
    WHERE lower(replace(r.customer_handle, '@', '')) = ${normalizeId(handle)}
    ORDER BY r.created_at DESC
  `
  return rows.map((r) => toRequest(r))
}

/** Staff path. LEFT JOIN for the same reason as above. Also surfaces the
 *  WhatsApp claim-inbox fields (source/sendId/etc.), the resolved code for a
 *  claimed row (via the wa_send_codes join), and — for an 'asking' row — its
 *  full candidate list, batch-resolved in one extra query below (never
 *  N+1). */
export async function getCatalogueRequests(
  onlyPending: boolean,
  db: DBExecutor = sql,
): Promise<CatalogueRequest[]> {
  // customer_handle is a snapshot frozen at insert time — a renamed customer
  // (customers.instagram_id changed) leaves old rows showing the old name.
  // 'catalogue'-sourced rows carry customer_id and resolve via that. A
  // WhatsApp-sourced row has no customer_id, but its sender phone number
  // still matches customers.whatsapp, so it resolves through that instead.
  // Only a row with neither (an unlinked customer) falls back to the frozen
  // snapshot.
  const rows = onlyPending
    ? await db`
        SELECT r.id, COALESCE(cu.instagram_id, cw.instagram_id, r.customer_handle) AS customer_handle,
               r.product_id, p.name AS product_name,
               r.description, r.reference_image_url,
               r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at,
               r.country_id, c.name AS country_name, r.valas, r.gram, r.estimated_price,
               r.proposed_pricing_method, r.proposed_profit_pct, r.proposed_operational_fee,
               r.proposed_packing_fee, r.proposed_tiered_kurs, r.proposed_name,
               r.post_id, h.default_event,
               r.source, r.send_id, r.send_code_id, r.sender, r.message_id,
               r.bot_message_id, r.candidate_send_code_ids,
               sc.code AS resolved_code, sc.send_id AS resolved_code_send_id,
               ws.event AS resolved_event
        FROM catalogue_requests r
        LEFT JOIN products p ON p.id = r.product_id
        LEFT JOIN countries c ON c.id = r.country_id
        LEFT JOIN catalogue_posts cp ON cp.id = r.post_id
        LEFT JOIN catalogue_highlights h ON h.id = cp.highlight_id
        LEFT JOIN wa_send_codes sc ON sc.id = r.send_code_id
        LEFT JOIN wa_sends ws ON ws.id = r.send_id
        LEFT JOIN customers cu ON cu.id = r.customer_id
        LEFT JOIN customers cw ON cw.whatsapp <> '' AND cw.whatsapp = split_part(split_part(r.sender, '@', 1), ':', 1)
        WHERE r.status IN ('pending', 'asking', 'offer_pending', 'approved')
        ORDER BY r.created_at ASC
      `
    : await db`
        SELECT r.id, COALESCE(cu.instagram_id, cw.instagram_id, r.customer_handle) AS customer_handle,
               r.product_id, p.name AS product_name,
               r.description, r.reference_image_url,
               r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at,
               r.country_id, c.name AS country_name, r.valas, r.gram, r.estimated_price,
               r.proposed_pricing_method, r.proposed_profit_pct, r.proposed_operational_fee,
               r.proposed_packing_fee, r.proposed_tiered_kurs, r.proposed_name,
               r.post_id, h.default_event,
               r.source, r.send_id, r.send_code_id, r.sender, r.message_id,
               r.bot_message_id, r.candidate_send_code_ids,
               sc.code AS resolved_code, sc.send_id AS resolved_code_send_id,
               ws.event AS resolved_event
        FROM catalogue_requests r
        LEFT JOIN products p ON p.id = r.product_id
        LEFT JOIN countries c ON c.id = r.country_id
        LEFT JOIN catalogue_posts cp ON cp.id = r.post_id
        LEFT JOIN catalogue_highlights h ON h.id = cp.highlight_id
        LEFT JOIN wa_send_codes sc ON sc.id = r.send_code_id
        LEFT JOIN wa_sends ws ON ws.id = r.send_id
        LEFT JOIN customers cu ON cu.id = r.customer_id
        LEFT JOIN customers cw ON cw.whatsapp <> '' AND cw.whatsapp = split_part(split_part(r.sender, '@', 1), ':', 1)
        ORDER BY r.created_at DESC
      `

  // Batch-resolve every row's candidate codes in ONE additional query
  // (not N+1) — collect every candidate id across all rows first.
  const allCandidateIds = rows.flatMap((r) => (r.candidate_send_code_ids as number[] | null) ?? [])
  const candidateRows = allCandidateIds.length > 0
    ? await db`
        SELECT c.id, c.code, c.product_id, p.name AS product_name, c.price
        FROM wa_send_codes c JOIN products p ON p.id = c.product_id
        WHERE c.id = ANY(${allCandidateIds})
      `
    : []
  const candidateById = new Map<number, Candidate>(candidateRows.map((c) => [c.id as number, {
    id: c.id as number, code: c.code as string, productId: c.product_id as number,
    productName: c.product_name as string, price: Number(c.price),
  }]))

  return rows.map((r) => toRequest(r, candidateById))
}

/** Converts one request into a real order. A Fix request already carries
 *  its product_id; a custom request (product_id null) requires the caller
 *  to supply productIdOverride — staff picks a real product in the Convert
 *  modal before this is called. Both cases resolve to one final productId,
 *  then snapshot that product's current price (same convention as every
 *  other order-creation path), same as before this change.
 *
 *  Race protection unchanged: the initial SELECT locks the row (`FOR
 *  UPDATE`) and the final UPDATE re-checks `status IN ('pending',
 *  'approved')`, so two
 *  concurrent conversions of the same request can't both create an order —
 *  the loser's SELECT blocks until the winner commits, then sees the
 *  already-flipped status and gets zero rows, throwing before any order is
 *  created. The SELECT no longer JOINs products (product_id may be null),
 *  and the LEFT JOIN to wa_sends below (added only to read group_jid for a
 *  WhatsApp-sourced row) is excluded from the lock via `FOR UPDATE OF r`,
 *  so the lock still covers exactly one table — simpler, not weaker.
 *
 *  A `source = 'whatsapp'` row additionally gets a ✅ reaction queued on the
 *  customer's original group message, in the SAME transaction as the order
 *  creation and status flip — a rollback of one rolls back the other. */
export async function convertCatalogueRequest(
  id: number,
  event: string,
  actor: string | null,
  productIdOverride?: number,
): Promise<{ orderId: number }> {
  return withActor(actor, async (tx) => {
    const [request] = await tx`
      SELECT r.customer_handle, r.product_id, r.qty, r.note, r.source, r.message_id, r.sender, ws.group_jid,
             sc.price AS send_price
      FROM catalogue_requests r
      LEFT JOIN wa_sends ws ON ws.id = r.send_id
      LEFT JOIN wa_send_codes sc ON sc.id = r.send_code_id
      WHERE r.id = ${id} AND r.status IN ('pending', 'approved')
      FOR UPDATE OF r
    `
    if (!request) throw new Error("Request not found or already handled")

    // Refused when the identity behind a WhatsApp claim was never resolved
    // to a real customer record — the spec's third conversion guard. Without
    // this, appendOrders' auto-create-on-conflict would silently key a new
    // customers row off the raw phone-number fallback createDirectClaim/
    // createAskingRequest/createRejectedClaim use when findCustomerByNumber
    // comes back empty. A 'catalogue'-source row's customer_handle is always
    // a real submitted handle, so this guard is scoped to source = 'whatsapp'
    // only — unchanged behaviour for every other row.
    if (request.source === "whatsapp") {
      const [customer] = await tx`
        SELECT 1 FROM customers WHERE instagram_id = ${normalizeId(request.customer_handle as string)}
      `
      if (!customer) {
        throw new Error(
          "This customer's identity has not been resolved to an Instagram account yet — cannot convert",
        )
      }
    }

    // An explicit override always wins, not just when the row has no
    // product yet — "Duplicate as variant" passes one specifically to
    // REPLACE an already-matched product (the whole point being that the
    // matched one is the wrong variant), so falling back to request.
    // product_id first silently ignored it and converted onto the old
    // product every time.
    const resolvedProductId = productIdOverride ?? (request.product_id as number | null) ?? null
    if (resolvedProductId === null) {
      throw new Error("A product must be selected to convert a custom request")
    }

    // A WhatsApp-sourced row converts at the price the send actually posted
    // at (wa_send_codes.price, snapshotted when the product was tagged onto
    // the send) — repricing the product afterwards must not silently change
    // what she agreed to. A 'catalogue'-source row has no send_code_id, so
    // send_price is always null there and this falls through to the live
    // product price exactly as before. That snapshot is for the ORIGINAL
    // product's code specifically — an override that points this convert at
    // a DIFFERENT product (Duplicate as variant) makes it meaningless, so it
    // only applies when the resolved product is still the one the code was
    // actually for.
    let unitPrice: number
    if (request.source === "whatsapp" && request.send_price != null && resolvedProductId === request.product_id) {
      unitPrice = Number(request.send_price)
    } else {
      const [product] = await tx`SELECT price FROM products WHERE id = ${resolvedProductId}`
      if (!product) throw new Error("Selected product not found")
      unitPrice = product.price as number
    }

    const [created] = await appendOrders(
      [{
        event,
        customer: request.customer_handle as string,
        productId: resolvedProductId,
        unitPrice,
        unit: request.qty as number,
        note: request.note as string,
      }],
      tx,
    )

    const rows = await tx`
      UPDATE catalogue_requests
      SET status = 'converted', converted_order_id = ${created.id}, updated_at = NOW()
      WHERE id = ${id} AND status IN ('pending', 'approved')
      RETURNING id
    `
    if (rows.length === 0) throw new Error("Request not found or already handled")

    if (request.source === "whatsapp" && request.message_id) {
      await queueReaction(
        request.group_jid as string, request.message_id as string, "✅", request.sender as string, tx,
      )
    }

    return { orderId: created.id }
  })
}

/** A `source = 'whatsapp'` row additionally gets a ❌ reaction queued on the
 *  customer's original group message — read via a second query on the same
 *  `db` handle, same pattern as resolveAskingCandidate's owner-side reply,
 *  since (like that function) this one isn't wrapped in a transaction.
 *
 *  Also accepts a starting status of 'asking' — the owner's only action on
 *  a zero-candidate asking row (the bot asked "kodenya yang mana kak?" and
 *  found nothing to offer at all; see the final whole-branch review's
 *  finding 1). Such a row has product_id NULL and description '' — legal
 *  only while status = 'asking' (catalogue_requests_product_or_description,
 *  migration 081) — so leaving 'asking' without also populating description
 *  would violate that constraint on this exact UPDATE. The CASE below sets
 *  description from the row's own `note` (the customer's original message,
 *  same text createRejectedClaim already uses for its own closed-trip
 *  'rejected' rows) ONLY when product_id/description are both still empty;
 *  every other caller of this function (a normal pending/approved reject,
 *  always already carrying a product_id or a real description) leaves its
 *  description untouched. */
export async function rejectCatalogueRequest(
  id: number,
  staffNote: string,
  db: DBExecutor = sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_requests
    SET status = 'rejected', staff_note = ${staffNote}, updated_at = NOW(),
        description = CASE
          WHEN product_id IS NULL AND description = '' THEN note
          ELSE description
        END
    WHERE id = ${id} AND status IN ('pending', 'approved', 'asking')
    RETURNING id, source, message_id, send_id, sender
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")

  const [row] = rows
  if (row.source === "whatsapp" && row.message_id) {
    const [send] = await db`SELECT group_jid FROM wa_sends WHERE id = ${row.send_id}`
    await queueReaction(send.group_jid as string, row.message_id as string, "❌", row.sender as string, db)
  }
}

const EDIT_ROUND_TO = 1000

/** Owner-only: propose a country/valas/gram revision on a pending custom
 *  request, under either pricing method Add Product itself supports for a
 *  custom negotiation:
 *
 *  - 'overseas' (Profit Margin): profit%/operationalFee/packingFee default
 *    to Settings' customRequestProfitPct/-OperationalFee/-PackingFee
 *    (migration 090) when the caller doesn't override them — meant to
 *    mirror the customer-facing form's own live-estimate formula (a
 *    separate repo) without needing a code change on this side whenever
 *    that formula changes, which is what makes the "Customer's own
 *    estimate" comparison box meaningful.
 *  - 'tier_kurs': the charged rate is resolved server-side from
 *    country_kurs_tiers (getTierKursInputs/resolveTieredKurs), exactly like
 *    computeProductPrice does for a real product — never trusted from the
 *    caller. packingFee still applies; profitPct/operationalFee don't
 *    (the rate spread IS the margin) and are stored null.
 *
 *  roundTo stays flat at 1000 for 'overseas' regardless of Settings'
 *  profitMarginRoundTo — NOT the public estimator's relative-precision
 *  rounding; see this plan's Global Constraints for why that distinction
 *  matters here. 'tier_kurs' uses product_defaults.tier_kurs_round_to
 *  (via getTierKursInputs) since there's no equivalent reason to diverge
 *  from how a real Tier Kurs product rounds.
 *
 *  Guarded: only from 'pending', moves to 'offer_pending'. Re-editing while
 *  already offer_pending is NOT allowed here — the UI's two-step
 *  cancel-edit → edit path handles that, since allowing it directly here
 *  would let a concurrent revision land on a row the customer just
 *  approved under a different (unseen) price. */
export async function editCatalogueRequest(
  id: number,
  data: {
    countryId: number
    valas: number
    gram: number
    name: string
    pricingMethod?: "overseas" | "tier_kurs"
    profitPct?: number
    operationalFee?: number
    packingFee?: number
  },
  db: DBExecutor = sql,
): Promise<{ estimatedPrice: number }> {
  const rate = await getCountryRate(data.countryId, db)
  if (!rate) throw new Error("Country not found")

  const pricingMethod = data.pricingMethod ?? "overseas"
  const defaults = await getProductDefaults(db)

  let price: number
  let profitPct: number | null = null
  let operationalFee: number | null = null
  let packingFee: number
  let tieredKurs: number | null = null

  if (pricingMethod === "tier_kurs") {
    packingFee = data.packingFee ?? defaults.customRequestPackingFee
    const { kursTiers, roundTo } = await getTierKursInputs(data.countryId, db)
    tieredKurs = resolveTieredKurs(kursTiers, data.valas, rate.kurs)
    ;({ price } = calcKursPrice({
      valas: data.valas,
      chargedKurs: tieredKurs,
      kurs: rate.kurs,
      gram: data.gram,
      cargoPerKg: rate.cargoPerKg,
      packingFee,
      roundTo,
    }))
  } else {
    profitPct = data.profitPct ?? defaults.customRequestProfitPct
    operationalFee = data.operationalFee ?? defaults.customRequestOperationalFee
    packingFee = data.packingFee ?? defaults.customRequestPackingFee
    ;({ price } = calcAbroadPrice({
      valas: data.valas,
      kurs: rate.kurs,
      gram: data.gram,
      cargoPerKg: rate.cargoPerKg,
      profitPct,
      operationalFee,
      packingFee,
      roundTo: EDIT_ROUND_TO,
    }))
  }

  const rows = await db`
    UPDATE catalogue_requests
    SET country_id = ${data.countryId}, valas = ${data.valas}, gram = ${data.gram},
        estimated_price = ${price},
        proposed_name = ${data.name},
        proposed_pricing_method = ${pricingMethod},
        proposed_profit_pct = ${profitPct}, proposed_operational_fee = ${operationalFee},
        proposed_packing_fee = ${packingFee}, proposed_tiered_kurs = ${tieredKurs},
        status = 'offer_pending', updated_at = NOW()
    WHERE id = ${id} AND status = 'pending'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
  return { estimatedPrice: price }
}

/** Owner-only: withdraw a proposed revision that hasn't been answered yet
 *  (e.g. a typo) without asking the customer to reject it. Clears the four
 *  offer columns and returns to 'pending'. */
export async function cancelEditCatalogueRequest(
  id: number,
  db: DBExecutor = sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_requests
    SET country_id = NULL, valas = NULL, gram = NULL, estimated_price = NULL,
        proposed_name = NULL,
        proposed_pricing_method = 'overseas', proposed_tiered_kurs = NULL,
        proposed_profit_pct = NULL, proposed_operational_fee = NULL, proposed_packing_fee = NULL,
        status = 'pending', updated_at = NOW()
    WHERE id = ${id} AND status = 'offer_pending'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
}

/** Public path: customer approves a revised offer. `db` must be the
 *  scoped `catalogue_public` connection (has UPDATE(status) only, per
 *  migration 079 — this function never sets any other column). Guarded on
 *  both the id AND the handle, so one customer can't approve/reject
 *  another's offer by guessing an id — the handle is exactly as visible
 *  to the customer as the id is (both come back from the same status
 *  lookup response), so this isn't a stronger trust boundary than the
 *  rest of this feature already relies on. */
export async function approveCatalogueRequestOffer(
  id: number,
  customerHandle: string,
  db: postgres.Sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_requests
    SET status = 'approved', updated_at = NOW()
    WHERE id = ${id}
      AND lower(replace(customer_handle, '@', '')) = ${normalizeId(customerHandle)}
      AND status = 'offer_pending'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
}

/** Public path: customer rejects a revised offer — terminal, same as a
 *  staff reject. */
export async function rejectCatalogueRequestOffer(
  id: number,
  customerHandle: string,
  db: postgres.Sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_requests
    SET status = 'rejected', updated_at = NOW()
    WHERE id = ${id}
      AND lower(replace(customer_handle, '@', '')) = ${normalizeId(customerHandle)}
      AND status = 'offer_pending'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
}

/** Owner-only: reopen a rejected request back to pending — the recovery
 *  path for a mistaken or forced customer reject, since nothing else in
 *  this file accepts 'rejected' as a starting status. */
export async function reopenCatalogueRequest(
  id: number,
  db: DBExecutor = sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_requests
    SET status = 'pending', updated_at = NOW()
    WHERE id = ${id} AND status = 'rejected'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
}

// --- WhatsApp claim inbox -------------------------------------------------
// The five functions below turn a WhatsApp group reply into the same
// catalogue_requests inbox row the public catalogue path writes, sourced
// 'whatsapp' instead of 'catalogue'. See migration 081 for the schema and
// docs/superpowers/specs/2026-08-19-whatsapp-product-post-design.md for the
// direct/asking/rejected shape.

/** She quoted (or landed on) a code that resolves to exactly one product —
 *  the common case. Writes straight to 'pending', same status a Fix
 *  request lands on. */
export async function createDirectClaim(
  input: {
    customerHandle: string; productId: number; qty: number; note: string
    sendId: number; sendCodeId: number; sender: string; messageId: string
  },
  db: DBExecutor = sql,
): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO catalogue_requests
      (customer_handle, product_id, qty, note, source, send_id, send_code_id, sender, message_id, status)
    VALUES
      (${input.customerHandle}, ${input.productId}, ${input.qty}, ${input.note},
       'whatsapp', ${input.sendId}, ${input.sendCodeId}, ${input.sender}, ${input.messageId}, 'pending')
    RETURNING id
  `
  return { id: row.id as number }
}

/** She named something ambiguous enough to match more than one candidate
 *  code on the send — no product_id yet, status 'asking' until either she
 *  or the owner picks one via resolveAskingCandidate. product_id NULL here
 *  is what the 'asking' status check constraint exists for. */
export async function createAskingRequest(
  input: {
    customerHandle: string; qty: number; note: string; sendId: number
    sender: string; messageId: string; botMessageId: string; candidateSendCodeIds: number[]
  },
  db: DBExecutor = sql,
): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO catalogue_requests
      (customer_handle, qty, note, source, send_id, sender, message_id, bot_message_id,
       candidate_send_code_ids, status)
    VALUES
      (${input.customerHandle}, ${input.qty}, ${input.note}, 'whatsapp', ${input.sendId},
       ${input.sender}, ${input.messageId}, ${input.botMessageId},
       ${input.candidateSendCodeIds}, 'asking')
    RETURNING id
  `
  return { id: row.id as number }
}

/** Written when a send's event is not the group's currently-bound one — she
 *  quoted (or landed on, unquoted) a trip that has already closed.
 *  product_id is NULL and status is 'rejected' (not 'asking'), so unlike
 *  createDirectClaim/createAskingRequest this row only satisfies the
 *  catalogue_requests_product_or_description check constraint if
 *  description is non-empty — set from the note, mirroring how a custom
 *  catalogue request's description carries the customer's own text. */
export async function createRejectedClaim(
  input: { customerHandle: string; qty: number; note: string; sendId: number; sender: string; messageId: string },
  db: DBExecutor = sql,
): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO catalogue_requests
      (customer_handle, qty, note, description, source, send_id, sender, message_id, status, staff_note)
    VALUES
      (${input.customerHandle}, ${input.qty}, ${input.note}, ${input.note}, 'whatsapp', ${input.sendId},
       ${input.sender}, ${input.messageId}, 'rejected', 'trip sudah tutup')
    RETURNING id
  `
  return { id: row.id as number }
}

/**
 * Settle an 'asking' row onto one of its candidates. Guarded on
 * `status = 'asking'` so a second call — her 👍 arriving after the owner
 * already picked, or vice versa — is a no-op, which is what makes both
 * sides of the ❔ question safely idempotent.
 *
 * `resolvedBy: "owner"` additionally queues the closing group message,
 * because a dashboard action has no socket of its own (see
 * "Delivering a dashboard action to the group" in the spec). The customer
 * side never queues one — she is either already looking at the bot's live
 * reply, or the worker sends it inline in the same pass that called this.
 */
export async function resolveAskingCandidate(
  id: number,
  sendCodeId: number,
  resolvedBy: "customer" | "owner",
  db: DBExecutor = sql,
): Promise<void> {
  const [resolved] = await db`
    UPDATE catalogue_requests
    SET product_id = (SELECT product_id FROM wa_send_codes WHERE id = ${sendCodeId}),
        send_id = (SELECT send_id FROM wa_send_codes WHERE id = ${sendCodeId}),
        send_code_id = ${sendCodeId},
        status = 'pending',
        updated_at = NOW()
    WHERE id = ${id} AND status = 'asking'
    RETURNING message_id, qty, sender
  `
  if (!resolved) return
  if (resolvedBy !== "owner") return

  const [send] = await db`
    SELECT s.group_jid, sc.code
    FROM wa_sends s JOIN wa_send_codes sc ON sc.id = ${sendCodeId}
    WHERE s.id = sc.send_id
  `
  await queueText(
    send.group_jid as string,
    resolved.message_id as string,
    `Sudah dicatat ya kak — ${send.code} ×${resolved.qty} ✅`,
    resolved.sender as string,
    db,
  )
}

/**
 * Owner manually assigns a product to a zero-candidate 'asking' row — the
 * bot found nothing to offer at all, but a personal DM cleared up what she
 * actually wants. No code/price snapshot to carry (there was never a
 * candidate code for this row), so this leaves send_code_id untouched
 * (null) and convertCatalogueRequest's own fallback (send_price null → live
 * product price) takes over at conversion time, same as a 'catalogue'-
 * sourced row already does.
 */
export async function resolveAskingManually(
  id: number,
  productId: number,
  db: DBExecutor = sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_requests
    SET product_id = ${productId}, status = 'pending', updated_at = NOW()
    WHERE id = ${id} AND status = 'asking'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
}

/**
 * Owner manually attaches a WhatsApp claim's phone number to a real
 * customer's Instagram handle — the fix for a row whose number
 * findCustomerByNumber couldn't match at claim time (resolveCustomerHandle
 * falls back to the bare number, see worker/product-post.ts), which
 * otherwise converts fine right up until convertCatalogueRequest's identity
 * guard refuses it. Updates THIS row's own customer_handle so it converts
 * cleanly, and backfills the number onto the customer record
 * (linkSenderToCustomer) so every future claim from the same number
 * resolves automatically instead of repeating this by hand each time.
 */
export async function resolveRequestIdentity(
  id: number,
  handle: string,
  db: DBExecutor = sql,
): Promise<void> {
  const normalized = normalizeId(handle)
  const [request] = await db`SELECT sender FROM catalogue_requests WHERE id = ${id} AND source = 'whatsapp'`
  if (!request) throw new Error("Request not found")

  const [customer] = await db`SELECT 1 FROM customers WHERE instagram_id = ${normalized}`
  if (!customer) throw new Error(`No such customer: ${normalized}`)

  await db`UPDATE catalogue_requests SET customer_handle = ${normalized}, updated_at = NOW() WHERE id = ${id}`

  // Same device-suffix stripping worker/product-post.ts's senderNumber does —
  // linkSenderToCustomer's own digit-strip doesn't drop a WhatsApp
  // participant JID's ":12" device suffix on its own.
  const number = ((request.sender as string).split("@")[0] ?? "").split(":")[0].replace(/\D/g, "")
  if (number) await linkSenderToCustomer(number, normalized)
}

/** Find the still-open 'asking' row the bot itself posted (matched by the
 *  bot's own outgoing message id, not the customer's) — how a 👍 reaction
 *  to the bot's question routes back to the row it belongs to. Once
 *  resolved the row falls out of this lookup (status is no longer
 *  'asking'), so a reaction arriving late finds nothing to act on. */
export async function findRequestByBotMessage(
  botMessageId: string,
  db: DBExecutor = sql,
): Promise<CatalogueRequest | null> {
  const [row] = await db`
    SELECT * FROM catalogue_requests WHERE bot_message_id = ${botMessageId} AND status = 'asking'
  `
  return row ? toRequest(row) : null
}

/** The handful of fields a "proof of her message" export needs — what she
 *  actually wrote, who, and when. Owner-read path only; 'catalogue'-source
 *  rows have no real WhatsApp message behind them, so this only ever
 *  resolves for source = 'whatsapp'. */
export async function getRequestProofData(
  id: number,
  db: DBExecutor = sql,
): Promise<{ customerHandle: string; note: string; sender: string; createdAt: Date; event: string | null } | null> {
  const [row] = await db`
    SELECT r.customer_handle, r.note, r.sender, r.created_at, ws.event
    FROM catalogue_requests r
    LEFT JOIN wa_sends ws ON ws.id = r.send_id
    WHERE r.id = ${id} AND r.source = 'whatsapp'
  `
  if (!row) return null
  return {
    customerHandle: row.customer_handle as string,
    note: row.note as string,
    sender: row.sender as string,
    createdAt: row.created_at as Date,
    event: (row.event as string | null) ?? null,
  }
}
