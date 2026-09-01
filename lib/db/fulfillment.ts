import { randomUUID } from "node:crypto"
import { refundForReduction, invoiceTotalsNow, type MarkReduction } from "./mark-refunds"
import { reconcileParcelPlan } from "./parcel-plan"
import sql from "../db-pool"
import { normalizeId, normalizeCustomer, tsToString, splitExtraOngkir, parcelPlanExtra } from "./helpers"
import { allocateFifo } from "../fifo-fill"
import type { DBExecutor } from "./actor"
import type { ShipOrderLine, ShipCustomer, ShipStatus, ShipOrdersParams, ShipMergedParams, ShipMergedResult, ShippingRecord, CustomerDetail, ExcessTransitItem, ExcessReason } from "./types"
import { getPaymentStatus, type PaymentStatus } from "./finance"
import { fetchPaidStatusMap, compareOrderPriority, type PaidStatus } from "./shopping-list"
import { appendExcessPurchase, reduceOrderRefundOnly } from "./orders"
import { notifyCustomer } from "./announcements"

/**
 * Refusal to ship a parcel that would be billed nothing.
 *
 * ongkirPerKg reaches this file from the request body and is written straight
 * onto the shipment, so a zero is not an error state — it is the price. The
 * card carried an amber "Ongkir belum ada" pill and nothing else: a warning
 * where a block belonged, and bulk ship never showed it at all, sending any
 * number of unbilled parcels in one press.
 *
 * The rest of this codebase is emphatic that a missing rate must never become
 * free shipping — "never written as 0 either, because 0 is free shipping" —
 * and this was the one path that let it.
 */
export class NoShippingRateError extends Error {
  constructor(readonly events: string[]) {
    super(
      `Belum ada ongkir untuk ${events.join(", ")} — atur tarifnya dulu, `
      + "paket ini akan tercatat tanpa biaya kirim.",
    )
    this.name = "NoShippingRateError"
  }
}

/** Refusal to ship one half of a pair without saying so out loud. */
export class PairedShipmentError extends Error {
  constructor(message: string, readonly partners: string[]) {
    super(message)
    this.name = "PairedShipmentError"
  }
}

/** The other events this one was asked to travel with. */
async function pairedPartners(customer: string, event: string): Promise<string[]> {
  const custKey = normalizeId(customer)
  const rows = await sql<{ event: string }[]>`
    WITH mine AS (
      SELECT p.merge_key
        FROM customer_shipping_prefs p
        JOIN customers c ON c.id = p.customer_id
       WHERE p.event = ${event}
         AND p.merge_key IS NOT NULL
         AND lower(replace(c.instagram_id, '@', '')) = ${custKey}
    )
    SELECT p.event
      FROM customer_shipping_prefs p
      JOIN customers c ON c.id = p.customer_id
      JOIN mine ON mine.merge_key = p.merge_key
     WHERE p.event <> ${event}
       AND lower(replace(c.instagram_id, '@', '')) = ${custKey}
  `
  return rows.map((r) => r.event)
}

// ─── Ship Orders ────────────────────────────────────────────────────────────

function buildSearchFilters(opts: { event?: string; search?: string }) {
  const conditions: string[] = []
  const params: (string | number)[] = []
  if (opts.event) {
    params.push(opts.event)
    conditions.push(`o.event = $${params.length}`)
  }
  if (opts.search) {
    params.push(`%${normalizeId(opts.search)}%`)
    conditions.push(`lower(replace(o.customer, '@', '')) LIKE $${params.length}`)
  }
  return { conditions, params }
}

function buildShipGroups(
  orderRows: Record<string, unknown>[],
  detailMap: Map<string, CustomerDetail>,
  paymentMap: Map<string, PaymentStatus>,
  ongkirMap: Map<string, number>,
  addressMap: Map<string, RequestedAddress>,
  splitAsked: Set<string>,
  splitBilled: Set<string>,
  pairing: Map<string, string>,
): ShipCustomer[] {
  const groupMap = new Map<string, { customer: string; event: string; rows: Record<string, unknown>[] }>()
  for (const row of orderRows) {
    const key = `${normalizeId(row.customer as string)}|${row.event}`
    if (!groupMap.has(key)) groupMap.set(key, { customer: row.customer as string, event: row.event as string, rows: [] })
    groupMap.get(key)!.rows.push(row)
  }

  return Array.from(groupMap.values()).flatMap(({ customer, event, rows }) => {
    const customerKey = normalizeId(customer)
    // Lines with unit === 0 are cancelled (missing/wrong-product/broken arrival,
    // or a fully-voided order) — nothing to receive or ship, so drop them from
    // the packing list entirely rather than let them park a card in "Belum Tiba".
    const orders: ShipOrderLine[] = rows
      .filter((r) => ((r.unit as number) ?? 0) > 0)
      .map((r) => {
        const unitArrive = (r.unit_arrive as number) ?? 0
        const unitShip = (r.unit_ship as number) ?? 0
        const unitHold = (r.unit_hold as number) ?? 0
        return {
          rowNumber: r.id as number,
          event,
          items: `${r.product_name} x ${r.unit}`,
          productId: r.product_id as number,
          productName: r.product_name as string,
          gram: (r.gram as number) ?? 0,
          unit: r.unit as number,
          unitPrice: (r.unit_price as number) ?? 0,
          unitArrive,
          unitShip,
          unitHold,
          toShip: Math.max(0, unitArrive - unitShip - unitHold),
        }
      })
    if (orders.length === 0) return []
    const totalToShipGram = orders.reduce((s, o) => s + o.gram * o.toShip, 0)
    const totalToShip = orders.reduce((s, o) => s + o.toShip, 0)
    const totalHold = orders.reduce((s, o) => s + o.unitHold, 0)
    const units = orders.reduce((s, o) => s + o.unit, 0)
    const totalShipped = orders.reduce((s, o) => s + o.unitShip, 0)
    const ongkirPerKg = ongkirMap.get(`${customerKey}|${event}`) ?? 0

    // Arrival-first status: compare arrived vs ordered units per line.
    const anyArrived = orders.some((o) => o.unitArrive > 0)
    const allArrived = orders.every((o) => o.unitArrive >= o.unit)
    // Default "unpaid" when no payment row exists (e.g. a customer who never had
    // orders/payments tied to this event yet) — keeps physically-ready cards
    // out of "Siap Dikirim" by default rather than slipping through.
    const paymentStatus: PaymentStatus = paymentMap.get(`${customerKey}|${event}`) ?? "unpaid"
    // "void" counts as clear: a zeroed invoice (e.g. offset by a Personal
    // Expense adjustment) has nothing to pay, so payment can't block shipping.
    const paymentClear = paymentStatus === "paid" || paymentStatus === "overpaid" || paymentStatus === "void"
    // "hold" wins over ready/shipped when any unit is parked — the customer
    // asked to wait, so we surface that even if some other units already went out.
    //
    // A declared split outranks "partial", and does so whether or not there is
    // anything on the bench today. The wish, not its current effect: once the
    // early box has gone the card has no toShip and is still a split running —
    // a fee is charged and a remainder is owed. Kirim Duluan is where that is
    // tracked. Requiring toShip here scattered the leftovers into Tiba
    // Sebagian, a tab that means "stock is here, decide", where they had
    // nothing to decide.
    const askedSplit = splitAsked.has(`${customerKey}|${event}`)
    // A pairing outranks every other status: the pair is the unit of work, and
    // the Gabung tab is the only place it can be acted on. Being held is not a
    // competing state here — parking is how pairing keeps the parcel still.
    const mergeKey = pairing.get(`${customerKey}|${event}`) ?? null
    const partners = mergeKey
      ? [...pairing.entries()]
          .filter(([k, v]) => v === mergeKey && k !== `${customerKey}|${event}`)
          .map(([k]) => k.split("|")[1])
      : []
    const bundled = partners.length > 0 && totalShipped < units
    const status: ShipStatus = bundled ? "paired" : !anyArrived
      ? "not_arrived"
      : !allArrived
        ? (totalHold > 0 ? "hold" : askedSplit ? "split_requested" : "partial")
        : totalHold > 0
          ? "hold"
          : totalToShip > 0
            ? (paymentClear ? "ready" : "ready_unpaid")
            : "shipped"

    return [{
      customer,
      event,
      customerDetail: detailMap.get(customerKey) ?? null,
      orders,
      totalToShip,
      // Billed weight is rounded up to the next whole kg (courier-style),
      // matching how invoices compute ongkir.
      weightKg: Math.ceil(totalToShipGram / 1000),
      ongkirPerKg,
      status,
      paymentStatus,
      requestedAddress: addressMap.get(`${customerKey}|${event}`)?.address ?? null,
      requestedOtherArea: addressMap.get(`${customerKey}|${event}`)?.otherArea ?? false,
      splitRequested: askedSplit,
      // Priced whether or not a split has been declared. Before, this was zero
      // until somebody committed — so the Split Ship button, whose whole job is
      // to say what pressing it will cost, promised "tidak menambah ongkir" on
      // every undeclared card, including the ones that cost a kilo.
      splitExtraOngkir: splitExtraOngkir(orders, ongkirPerKg),
      splitCharged: splitBilled.has(`${customerKey}|${event}`),
      mergeKey,
      pairedWith: partners,
    }]
  })
}

async function fetchCustomerDetails(customerIds: Set<string>): Promise<Map<string, CustomerDetail>> {
  const detailMap = new Map<string, CustomerDetail>()
  if (customerIds.size === 0) return detailMap
  const rows = await sql`
    SELECT instagram_id, name, whatsapp, data_diri, ekspedisi,
           bank_name, bank_account_number, bank_account_holder
    FROM customers
    WHERE lower(replace(instagram_id, '@', '')) = ANY(${[...customerIds]})
  `
  for (const r of rows) {
    const id = normalizeId(r.instagram_id)
    if (id) {
      detailMap.set(id, {
        name: r.name ?? "",
        whatsapp: r.whatsapp ?? "",
        dataDiri: r.data_diri ?? "",
        ekspedisi: r.ekspedisi ?? "",
        bankName: r.bank_name ?? "",
        bankAccountNumber: r.bank_account_number ?? "",
        bankAccountHolder: r.bank_account_holder ?? "",
      })
    }
  }
  return detailMap
}

/**
 * Per-(customer, event) ongkir, resolved from the event's warehouse. Keyed
 * `${normalizedCustomer}|${event}`. Ship groups are per (customer, event), so
 * each gets the rate for the warehouse that fulfills its event.
 */
/**
 * The one-off delivery addresses customers have asked for on these events.
 *
 * Without this the Ship modal seeds itself from customers.data_diri and the
 * label prints her usual address — while her own order card tells her the
 * parcel was redirected. Neither side finds out until it is delivered to the
 * wrong house, so the request has to reach the screen that prints the label.
 */
type RequestedAddress = { address: string; otherArea: boolean }

/**
 * The description written on the adjustment that bills an early parcel.
 *
 * It doubles as the record that the fee has been charged: there is no boolean
 * anywhere saying so, and the adjustment itself is the fact. Matching on it is
 * how the Ship screen knows not to bill twice, so it must stay stable — and it
 * is what the customer reads on her own invoice.
 */
export const SPLIT_ONGKIR_NOTE = "Ongkir kirim duluan"

/** The pairing groups these customers have asked for. */
async function fetchPairings(
  customerIds: Set<string>,
  eventNames: Set<string>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (customerIds.size === 0 || eventNames.size === 0) return map
  // Every event in a group this scope touches, not only the ones in scope: a
  // pairing filtered down to one member is not a pairing, and the card would
  // quietly go back to looking shippable on its own.
  const rows = await sql`
    WITH keys AS (
      SELECT DISTINCT p.customer_id, p.merge_key
        FROM customer_shipping_prefs p
        JOIN customers c ON c.id = p.customer_id
       WHERE p.merge_key IS NOT NULL
         AND p.event = ANY(${[...eventNames]})
         AND lower(replace(c.instagram_id, '@', '')) = ANY(${[...customerIds]})
    )
    SELECT p.event, lower(replace(c.instagram_id, '@', '')) AS norm_cust, p.merge_key
      FROM customer_shipping_prefs p
      JOIN keys k ON k.customer_id = p.customer_id AND k.merge_key = p.merge_key
      JOIN customers c ON c.id = p.customer_id
  `
  for (const r of rows) map.set(`${r.norm_cust}|${r.event}`, String(r.merge_key))
  return map
}

/** Who has asked for the arrived part to go early. */
async function fetchSplitRequests(
  customerIds: Set<string>,
  eventNames: Set<string>,
): Promise<Set<string>> {
  const keys = new Set<string>()
  if (customerIds.size === 0 || eventNames.size === 0) return keys
  const rows = await sql`
    SELECT p.event, lower(replace(c.instagram_id, '@', '')) AS norm_cust
      FROM customer_shipping_prefs p
      JOIN customers c ON c.id = p.customer_id
     WHERE p.mode = 'split'
       AND p.event = ANY(${[...eventNames]})
       AND lower(replace(c.instagram_id, '@', '')) = ANY(${[...customerIds]})
  `
  for (const r of rows) keys.add(`${r.norm_cust}|${r.event}`)
  return keys
}

/** Which of those have already had the extra delivery fee put on the invoice. */
async function fetchSplitCharges(
  customerIds: Set<string>,
  eventNames: Set<string>,
): Promise<Set<string>> {
  const keys = new Set<string>()
  if (customerIds.size === 0 || eventNames.size === 0) return keys
  const rows = await sql`
    SELECT event, lower(replace(customer, '@', '')) AS norm_cust
      FROM adjustments
     WHERE description = ${SPLIT_ONGKIR_NOTE}
       AND event = ANY(${[...eventNames]})
       AND lower(replace(customer, '@', '')) = ANY(${[...customerIds]})
  `
  for (const r of rows) keys.add(`${r.norm_cust}|${r.event}`)
  return keys
}


async function fetchRequestedAddresses(
  customerIds: Set<string>,
  eventNames: Set<string>,
): Promise<Map<string, RequestedAddress>> {
  const map = new Map<string, RequestedAddress>()
  if (customerIds.size === 0 || eventNames.size === 0) return map
  const rows = await sql`
    SELECT p.event,
           lower(replace(c.instagram_id, '@', '')) AS norm_cust,
           p.temp_address, p.temp_area_name,
           -- Her standing ongkir was priced for her own area. A redirect to a
           -- different one may cost differently, and that is a decision for a
           -- person, so it is surfaced rather than re-rated.
           (p.temp_area_id IS NOT NULL
             AND p.temp_area_id IS DISTINCT FROM c.biteship_area_id) AS other_area
      FROM customer_shipping_prefs p
      JOIN customers c ON c.id = p.customer_id
     WHERE p.temp_address IS NOT NULL
       AND p.event = ANY(${[...eventNames]})
       AND lower(replace(c.instagram_id, '@', '')) = ANY(${[...customerIds]})
  `
  for (const r of rows) {
    // Street then area, the way a label reads.
    const address = [String(r.temp_address), r.temp_area_name ? String(r.temp_area_name) : ""]
      .filter(Boolean)
      .join("\n")
    map.set(`${r.norm_cust}|${r.event}`, { address, otherArea: Boolean(r.other_area) })
  }
  return map
}

async function fetchEventOngkir(
  customerIds: Set<string>,
  eventNames: Set<string>,
): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (customerIds.size === 0 || eventNames.size === 0) return map
  const rows = await sql`
    SELECT ev.name AS event,
           lower(replace(c.instagram_id, '@', '')) AS norm_cust,
           COALESCE(cwo.effective_ongkir, 0)::int AS ongkir
    FROM events ev
    JOIN customer_warehouse_ongkir cwo ON cwo.warehouse_id = ev.warehouse_id
    JOIN customers c ON c.id = cwo.customer_id
    WHERE ev.name = ANY(${[...eventNames]})
      AND lower(replace(c.instagram_id, '@', '')) = ANY(${[...customerIds]})
  `
  for (const r of rows) map.set(`${r.norm_cust}|${r.event}`, Number(r.ongkir) || 0)
  return map
}

export { splitExtraOngkir, parcelPlanExtra }

export type ShipSegment = "all" | ShipStatus

export interface ShipOrdersFiltered {
  groups: ShipCustomer[]
  totalCount: number
  counts: Record<ShipSegment, number>
}

/**
 * How many paired groups are ready to leave.
 *
 * The pair decides its own timing, not each event in it: one box has one
 * departure. Every member asking to go early means the box goes now with
 * whatever has arrived; anything else means it waits for the slowest member,
 * which is what pairing asks for. A mixed pair therefore waits — you cannot
 * half-send a shared box.
 */
function countReadyBundles(groups: ShipCustomer[], splitAsked: Set<string>): number {
  const byKey = new Map<string, ShipCustomer[]>()
  for (const g of groups) {
    if (g.status !== "paired" || !g.mergeKey) continue
    const key = `${normalizeId(g.customer)}|${g.mergeKey}`
    const list = byKey.get(key)
    if (list) list.push(g)
    else byKey.set(key, [g])
  }
  let ready = 0
  for (const members of byKey.values()) {
    if (members.length < 2) continue
    // toShip is zero on a paired card by design — the pairing parked it — so
    // readiness counts what has arrived and not yet shipped, which is what the
    // box would actually contain once combining releases the parking.
    const waiting = (m: ShipCustomer) =>
      m.orders.reduce((n, o) => n + Math.max(0, o.unitArrive - o.unitShip), 0)
    const allSplit = members.every((m) => splitAsked.has(`${normalizeId(m.customer)}|${m.event}`))
    const done = allSplit
      ? members.some((m) => waiting(m) > 0)
      : members.every((m) => m.orders.every((o) => o.unitArrive >= o.unit))
    if (done) ready++
  }
  return ready
}

export async function getShipOrdersFiltered(opts: {
  segment?: ShipSegment
  search?: string
  event?: string
}): Promise<ShipOrdersFiltered> {
  const { segment = "all", search, event } = opts

  // Fetch every order line in scope (no arrival pre-filter) so each invoice
  // group carries its full set of lines — required to tell a fully-arrived
  // invoice from a partially-arrived one, and to show the not-yet-arrived
  // lines on a "Tiba Sebagian" card.
  const { conditions, params } = buildSearchFilters({ event, search })
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

  const orderRows = await sql.unsafe(
    `SELECT o.id, o.event, o.customer, o.product_id, p.name AS product_name,
            COALESCE(p.gram, 0) AS gram, o.unit, o.unit_price, o.unit_arrive, o.unit_ship, o.unit_hold
     FROM orders o
     JOIN products p ON p.id = o.product_id
     ${where}
     ORDER BY o.event, o.customer, o.id`,
    params,
  )

  const customerIds = new Set<string>()
  const eventNames = new Set<string>()
  for (const r of orderRows) {
    customerIds.add(normalizeId(r.customer))
    eventNames.add(String(r.event))
  }

  // Fetch customer details, per-event ongkir, and payment status concurrently —
  // all keyed by normalized customer handle (ongkir/payment additionally by event).
  const [detailMap, ongkirMap, addressMap, splitAsked, splitBilled, pairing, paymentRows] = await Promise.all([
    fetchCustomerDetails(customerIds),
    fetchEventOngkir(customerIds, eventNames),
    fetchRequestedAddresses(customerIds, eventNames),
    fetchSplitRequests(customerIds, eventNames),
    fetchSplitCharges(customerIds, eventNames),
    fetchPairings(customerIds, eventNames),
    getPaymentStatus(event),
  ])
  const paymentMap = new Map<string, PaymentStatus>()
  for (const row of paymentRows) paymentMap.set(`${row.customer}|${row.event}`, row.status)

  const allGroups = buildShipGroups(orderRows, detailMap, paymentMap, ongkirMap, addressMap, splitAsked, splitBilled, pairing)

  // Counts and the filtered list both derive from the same in-memory status,
  // so the tab badges can never drift from the rows actually shown.
  const counts: Record<ShipSegment, number> = {
    all: 0, not_arrived: 0, partial: 0, split_requested: 0, paired: 0, ready: 0, ready_unpaid: 0, hold: 0, shipped: 0,
  }
  const filteredGroups: ShipCustomer[] = []
  for (const g of allGroups) {
    counts.all++
    counts[g.status]++
    if (segment === "all" || g.status === segment) filteredGroups.push(g)
  }

  // The Gabung badge counts pairs that can go out, not cards that are paired.
  // A count that never returns to zero stops being read, and a pair waiting on
  // stock is not work — it is just waiting.
  counts.paired = countReadyBundles(allGroups, splitAsked)

  return {
    groups: filteredGroups,
    totalCount: filteredGroups.length,
    counts,
  }
}

/**
 * Retire a redirect once the parcel it was for has gone.
 *
 * "Kirim ke rumah ibu saya" is about one box, not about the trip. Nothing used
 * to end it, so the request outlived the parcel: the next box's sheet opened
 * with the toggle already on and her mother's address filled in, under a card
 * still badged "Alamat lain diminta". Everything on screen said she wanted it
 * again, and the second box followed the first.
 *
 * Only when the parcel actually used it. Ship to her profile instead and the
 * request was not honoured, so it stands.
 *
 * The address is not lost: shipments.temp_address keeps where that box really
 * went, which is the record worth having afterwards.
 */
async function clearHonouredRedirect(
  customer: string,
  events: string[],
  used: string | null,
  db: DBExecutor,
): Promise<void> {
  if (!used?.trim() || events.length === 0) return
  await db`
    UPDATE customer_shipping_prefs p
       SET temp_address = NULL, temp_area_id = NULL, temp_area_name = NULL,
           updated_at = NOW()
      FROM customers c
     WHERE c.id = p.customer_id
       AND p.event = ANY(${events})
       AND lower(replace(c.instagram_id, '@', '')) = ${normalizeId(customer)}
       AND p.temp_address IS NOT NULL
  `
}

export async function shipCustomerOrders(params: ShipOrdersParams, actor?: string | null): Promise<{ shippingId: string }> {
  const { customer, event, orders, weightKg, ongkirPerKg, tempAddress, force } = params
  // Before anything is written. A parcel billed nothing is not recoverable by
  // editing the rate afterwards: the shipment row keeps the figure it was
  // sent, and she has already been told what she owes.
  if (!(ongkirPerKg > 0)) throw new NoShippingRateError([event])
  // Empty-string and undefined both mean "no override" — store NULL so the
  // label flow can fall back to the customer's profile address.
  const tempAddressValue = tempAddress && tempAddress.trim() ? tempAddress : null

  // Checked here rather than in the button, so a bulk ship and a stray click
  // both meet it. `force` is the Ship-anyway confirm, and it clears the
  // pairing on the way past: a group of one is not a group, and the partner
  // must not be left promising a box that already left without it.
  if (!force) {
    const partners = await pairedPartners(customer, event)
    if (partners.length > 0) {
      throw new PairedShipmentError(
        `${event} dipasangkan dengan ${partners.join(", ")} oleh customer.`,
        partners,
      )
    }
  }

  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`
    // Only the ids we generate are numbers. A hand-entered or imported one
    // ("SHIP-2600", a courier's own reference) makes the cast throw and takes
    // every future shipment down with it, so they are skipped rather than cast.
    const [maxRow] = await tx`
      SELECT COALESCE(MAX(shipping_id::integer), 0) AS max_id
        FROM shipments WHERE shipping_id ~ '^[0-9]+$'
    `
    const shippingId = String((maxRow.max_id ?? 0) + 1).padStart(4, "0")

    const toShipRows = orders.filter((o) => o.toShip > 0)
    const invoicingText = toShipRows.map((o) => `${o.productName} x ${o.toShip}`).join("\n")
    // Bill ongkir per kg, rounded up to the next whole kg (courier-style).
    const billedKg = Math.ceil(weightKg)
    const ongkirTotal = ongkirPerKg * billedKg

    await tx`
      INSERT INTO shipments (event, customer, shipping_id, invoicing, weight_estimation, ongkir, ongkir_total, is_last_shipment, temp_address)
      VALUES (${event}, ${customer}, ${shippingId}, ${invoicingText}, ${billedKg}, ${ongkirPerKg}, ${ongkirTotal}, true, ${tempAddressValue})
    `

    for (const order of toShipRows) {
      await tx`
        UPDATE orders
        SET unit_ship = COALESCE(unit_ship, 0) + ${order.toShip}, updated_at = NOW()
        WHERE id = ${order.rowNumber}
      `
    }

    // Shipping alone against a pairing dissolves it, here rather than later:
    // the partner is now shipping on its own too, and its card should say so.
    if (force) {
      await tx`
        UPDATE customer_shipping_prefs SET merge_key = NULL, updated_at = NOW()
         WHERE merge_key = (SELECT p.merge_key FROM customer_shipping_prefs p
                              JOIN customers c ON c.id = p.customer_id
                             WHERE p.event = ${event}
                               AND lower(replace(c.instagram_id, '@', '')) = ${normalizeId(customer)})`
    }

    await clearHonouredRedirect(customer, [event], tempAddressValue, tx)

    // Her inbox, in the same transaction: a parcel that shipped without a
    // notice, or a notice about a parcel that did not, are both worse than
    // failing the whole thing. No tracking number here — whether a resi is
    // ready to be seen is the shop's call, made on the Shipments screen.
    const units = toShipRows.reduce((n, o) => n + o.toShip, 0)
    await notifyCustomer(customer, {
      title: `${event} is on its way`,
      body: `${units} ${units === 1 ? "item" : "items"} from ${event} left the warehouse in one parcel. `
        + `Your tracking number appears on the order once the shop adds it.`,
    }, tx)

    return { shippingId }
  })
}

/**
 * "Ship together": ship one customer's ready orders across several events as a
 * single physical package, in one transaction.
 *
 *  - Writes one shipment row per event, all sharing a generated merge_group, so
 *    the Shipments page can collapse them into one entry and one resi covers all.
 *  - The combined physical weight + ongkir land on the primary (first) row; the
 *    others get 0 weight/ongkir_total so summing the group isn't double-counted.
 *  - Marks the shipped order units like the single-event flow.
 *  - Bills ongkir ONCE: invoices recompute ongkir per event from the customer's
 *    FULL event order weight, so we add a single negative "Gabung ongkir"
 *    adjustment equal to the round-up overlap removed by combining the events
 *    (computed from those same full event weights, to stay consistent with the
 *    invoice math). Skipped when combining saves nothing.
 */
export async function shipMergedCustomerOrders(params: ShipMergedParams, actor?: string | null): Promise<ShipMergedResult> {
  const { customer, ongkirPerKg, groups, tempAddress } = params
  // One rate covers the whole box, so one missing rate voids the whole merge.
  if (!(ongkirPerKg > 0)) throw new NoShippingRateError(groups.map((g) => g.event))
  // Same value written to every row in the merge_group — one physical box,
  // one receiving address. NULL means "use the customer's profile address."
  const tempAddressValue = tempAddress && tempAddress.trim() ? tempAddress : null
  const custKey = normalizeId(customer)
  const events = groups.map((g) => g.event)

  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`

    // Pairing parks both parcels, and this is the door they leave by — so the
    // holds come off here rather than needing a Release first. Anything the
    // customer asked to hold outright is untouched: that is a different wish.
    for (const g of groups) {
      const [pref] = await tx<{ mode: string }[]>`
        SELECT p.mode FROM customer_shipping_prefs p
          JOIN customers c ON c.id = p.customer_id
         WHERE p.event = ${g.event}
           AND lower(replace(c.instagram_id, '@', '')) = ${custKey}`
      if (pref?.mode !== "hold") await releasePackingList({ customer, event: g.event }, tx)
    }

    // Physical weight of what's actually in the box (rounded up once overall).
    let totalShippedGram = 0
    for (const g of groups) for (const o of g.orders) totalShippedGram += (o.gram || 0) * o.toShip
    const combinedKg = Math.ceil(totalShippedGram / 1000)
    const combinedOngkir = ongkirPerKg * combinedKg

    // Billing discount: compare ongkir billed per event (full event weight,
    // each rounded up) against ongkir on the combined full weight (rounded once).
    const fullRows = await tx<{ event: string; full_gram: string }[]>`
      SELECT o.event AS event, SUM(COALESCE(p.gram, 0) * o.unit) AS full_gram
      FROM orders o
      JOIN products p ON p.id = o.product_id
      WHERE lower(replace(o.customer, '@', '')) = ${custKey} AND o.event = ANY(${events})
      GROUP BY o.event
    `
    let sumFullGram = 0
    let perEventOngkirTotal = 0
    for (const r of fullRows) {
      const fg = Number(r.full_gram) || 0
      sumFullGram += fg
      perEventOngkirTotal += ongkirPerKg * Math.ceil(fg / 1000)
    }
    const combinedBillingOngkir = ongkirPerKg * Math.ceil(sumFullGram / 1000)
    const discount = Math.max(0, perEventOngkirTotal - combinedBillingOngkir)

    // One shipping_id for the whole package — shared across the per-event rows.
    const [maxRow] = await tx`
      SELECT COALESCE(MAX(shipping_id::integer), 0) AS max_id
        FROM shipments WHERE shipping_id ~ '^[0-9]+$'`
    const shippingId = String(((maxRow.max_id ?? 0) as number) + 1).padStart(4, "0")
    const mergeGroup = randomUUID()

    let isPrimary = true
    for (const g of groups) {
      const toShipRows = g.orders.filter((o) => o.toShip > 0)
      const invoicingText = toShipRows.map((o) => `${o.productName} x ${o.toShip}`).join("\n")
      // Combined weight + ongkir live on the primary row only, so summing the
      // group's rows isn't double-counted.
      const weight = isPrimary ? combinedKg : 0
      const ongkirTotal = isPrimary ? combinedOngkir : 0

      await tx`
        INSERT INTO shipments (event, customer, shipping_id, invoicing, weight_estimation, ongkir, ongkir_total, is_last_shipment, merge_group, temp_address)
        VALUES (${g.event}, ${customer}, ${shippingId}, ${invoicingText}, ${weight}, ${ongkirPerKg}, ${ongkirTotal}, true, ${mergeGroup}, ${tempAddressValue})
      `
      for (const o of toShipRows) {
        await tx`
          UPDATE orders
          SET unit_ship = COALESCE(unit_ship, 0) + ${o.toShip}, updated_at = NOW()
          WHERE id = ${o.rowNumber}
        `
      }
      isPrimary = false
    }

    // The merge saving is not credited here any more. reconcileParcelPlan owns
    // it, and priced it the moment the merge was recorded — which is earlier
    // and better: she pays the right amount once, instead of paying for two
    // parcels and being credited after one arrives.
    //
    // Two writers of the same credit, with the same wording, would have paid
    // her the discount twice: the guard below only ever looked for the split
    // fee, so it could not have seen the reconciler's row.

    // The pairing is spent only when the whole group has gone. She asked for
    // these to travel together, not to travel together once — so what is left
    // behind stays paired and comes back to the Gabung tab as stock lands,
    // rather than becoming two loose parcels she has to pair a second time.
    //
    // "The whole group" means every event sharing the merge key, not just the
    // events in this box. A remainder ships as its own group, and scoping the
    // check to that call left the partner holding a key to a pairing that no
    // longer existed — a wish that could never be spent.
    const paired = await tx<{ event: string }[]>`
      SELECT p.event FROM customer_shipping_prefs p
        JOIN customers c ON c.id = p.customer_id
       WHERE lower(replace(c.instagram_id, '@', '')) = ${custKey}
         AND p.merge_key IS NOT NULL
         AND p.merge_key IN (
           SELECT p2.merge_key FROM customer_shipping_prefs p2
            WHERE p2.customer_id = p.customer_id AND p2.event = ANY(${events}))`
    const scope = paired.length ? paired.map((r) => r.event) : events
    const [outstanding] = await tx<{ n: string }[]>`
      SELECT COALESCE(SUM(o.unit - COALESCE(o.unit_ship, 0)), 0) AS n
        FROM orders o
       WHERE o.event = ANY(${scope})
         AND lower(replace(o.customer, '@', '')) = ${custKey}`
    if (Number(outstanding?.n ?? 0) <= 0) {
      await tx`
        UPDATE customer_shipping_prefs SET merge_key = NULL, updated_at = NOW()
         WHERE event = ANY(${scope})
           AND customer_id IN (SELECT id FROM customers
                                WHERE lower(replace(instagram_id, '@', '')) = ${custKey})`
    }

    // One box, one address: whichever of these trips asked for it, the request
    // has now been met and should not seed the next parcel.
    await clearHonouredRedirect(customer, events, tempAddressValue, tx)

    const units = groups.reduce((n, g) => n + g.orders.reduce((m, o) => m + o.toShip, 0), 0)
    await notifyCustomer(customer, {
      title: `${events.join(" and ")} went out together`,
      body: `${units} ${units === 1 ? "item" : "items"} travelled in one box, about ${combinedKg} kg. `
        + (discount > 0
            ? `One delivery fee instead of ${events.length} — Rp ${discount.toLocaleString("id-ID")} came off your invoice.`
            : `One delivery fee instead of ${events.length}.`),
    }, tx)

    return {
      mergeGroup,
      shippingId,
      shippingIds: [shippingId],
      discount,
      combinedKg,
      combinedOngkir,
    }
  })
}

// ─── Hold / Release ─────────────────────────────────────────────────────────

/**
 * Park every ready-to-ship unit on a customer's event into hold. Used when the
 * customer asks to delay shipment (typically to combine with a later event).
 * Sets unit_hold = unit_arrive - unit_ship for each line, which zeroes out toShip
 * and moves the card into the "Hold" segment until released.
 */
export async function holdPackingList(params: {
  customer: string
  event: string
}, db: DBExecutor = sql): Promise<void> {
  const { customer, event } = params
  const custKey = normalizeId(customer)
  await db`
    UPDATE orders
    SET unit_hold = GREATEST(COALESCE(unit_arrive, 0) - COALESCE(unit_ship, 0), 0),
        updated_at = NOW()
    WHERE event = ${event}
      AND lower(replace(customer, '@', '')) = ${custKey}
      AND COALESCE(unit_arrive, 0) - COALESCE(unit_ship, 0) > 0
  `
}

/**
 * Release a held packing list back to the ready pool by zeroing unit_hold across
 * the customer's event lines. After release the card returns to ready/ready_unpaid
 * (depending on payment) and can be shipped normally or via "Ship together".
 */
export async function releasePackingList(params: {
  customer: string
  event: string
}, db: DBExecutor = sql): Promise<void> {
  const { customer, event } = params
  const custKey = normalizeId(customer)
  await db`
    UPDATE orders
    SET unit_hold = 0, updated_at = NOW()
    WHERE event = ${event}
      AND lower(replace(customer, '@', '')) = ${custKey}
      AND COALESCE(unit_hold, 0) > 0
  `
}

/**
 * Re-park a customer's hold after new stock lands.
 *
 * holdPackingList writes unit_hold from the arrival counts as they stand when
 * it runs — a snapshot. But `mode = 'hold'` in customer_shipping_prefs is a
 * standing instruction that outlives the moment she gave it, so anything that
 * arrives afterwards is unheld and quietly packable: the card still says Tunda
 * Kirim while offering to ship the new units. Every path that raises
 * unit_arrive calls this, and the instruction wins again.
 *
 * Scoped to the handles the arrival actually touched — an arrival for one
 * customer is no reason to rewrite another's numbers. Runs on the caller's
 * transaction, so the parking and the arrival are one write or neither.
 */
export async function reapplyHoldsForArrival(
  event: string,
  customers: string[],
  db: DBExecutor = sql,
): Promise<void> {
  const keys = Array.from(new Set(customers.map((c) => normalizeId(c)))).filter(Boolean)
  if (keys.length === 0) return
  const rows = await db<{ instagram_id: string }[]>`
    SELECT c.instagram_id
      FROM customer_shipping_prefs p
      JOIN customers c ON c.id = p.customer_id
     WHERE p.event = ${event}
       -- A pairing parks the parcel exactly as a hold does, so it has to be
       -- re-applied on arrival for exactly the same reason.
       AND (p.mode = 'hold' OR p.merge_key IS NOT NULL)
       AND lower(replace(c.instagram_id, '@', '')) = ANY(${keys})
  `
  for (const row of rows) {
    await holdPackingList({ customer: row.instagram_id, event }, db)
  }
}

// ─── Shipments ──────────────────────────────────────────────────────────────

export async function getShippingRecords(sinceDays?: number | null): Promise<ShippingRecord[]> {
  // The shipments grid loads everything client-side (search/sort/merge/bulk
  // print all need the full set), and the `invoicing` packing text makes each
  // row heavy — so the whole-history fetch grows unbounded and dominates DB
  // egress over time. Default callers to a recent window; pass null for "all".
  // Filtering on created_at is safe for merge groups: rows shipped together
  // share a timestamp, so a window never splits a group.
  const windowClause =
    sinceDays != null && sinceDays > 0
      ? sql`AND s.created_at >= now() - make_interval(days => ${sinceDays})`
      : sql``
  // Join customers via the existing FK (shipments.customer → customers.instagram_id)
  // so the page can show the human-readable name alongside the IG handle.
  const rows = await sql`
    SELECT s.id, s.event, s.customer, c.name AS customer_name,
           s.shipping_id, s.invoicing,
           s.weight_estimation, s.weight_charged, s.ongkir, s.ongkir_total, s.is_last_shipment,
           s.created_at, s.updated_at, s.tracking_number, s.merge_group, s.temp_address
    FROM shipments s
    LEFT JOIN customers c ON c.instagram_id = s.customer
    WHERE s.shipping_id != ''
      ${windowClause}
    ORDER BY s.id ASC
  `
  return rows.map((r) => ({
    rowNumber: r.id,
    event: r.event,
    customer: r.customer,
    customerName: r.customer_name ?? "",
    shippingId: String(r.shipping_id).padStart(4, "0"),
    invoicing: r.invoicing ?? "",
    weightEstimation: Number(r.weight_estimation) || 0,
    weightCharged: r.weight_charged == null ? null : Number(r.weight_charged),
    ongkir: r.ongkir ?? 0,
    ongkirTotal: r.ongkir_total ?? 0,
    isLastShipment: r.is_last_shipment ?? false,
    createdAt: tsToString(r.created_at),
    updatedAt: tsToString(r.updated_at),
    createdAtTs: r.created_at ? new Date(r.created_at as string).getTime() : 0,
    updatedAtTs: r.updated_at ? new Date(r.updated_at as string).getTime() : 0,
    trackingNumber: r.tracking_number ?? "",
    mergeGroup: r.merge_group ?? null,
    tempAddress: r.temp_address ?? null,
  }))
}

export async function updateTrackingNumber(
  rowNumber: number,
  trackingNumber: string,
  db: DBExecutor = sql,
): Promise<void> {
  // What it says now, and whose parcel it is. Read first: whether this is news
  // depends on what was there before, and after the UPDATE that is gone.
  const rows = (await db`
    SELECT customer, event, COALESCE(tracking_number, '') AS tracking_number
      FROM shipments
     WHERE id = ${rowNumber}
        OR merge_group = (SELECT merge_group FROM shipments WHERE id = ${rowNumber} AND merge_group IS NOT NULL)
     ORDER BY id
  `) as unknown as { customer: string; event: string; tracking_number: string }[]

  // For a merged ("Ship together") shipment the resi is shared, so setting it on
  // any row applies to every row in the same merge_group; otherwise just the row.
  await db`
    UPDATE shipments
    SET tracking_number = ${trackingNumber}, updated_at = NOW()
    WHERE id = ${rowNumber}
       OR merge_group = (SELECT merge_group FROM shipments WHERE id = ${rowNumber} AND merge_group IS NOT NULL)
  `

  /**
   * Tell her, because the parcel notice deliberately could not.
   *
   * Shipping says the box has gone and that a number will appear later --
   * whether a resi is ready to be seen is the shop's call. This is that call
   * being made, so it is the moment she can be told.
   *
   * Once per box, not once per row: a merged shipment is several rows and one
   * physical parcel, and three notices about one box is the shop talking to
   * itself. Silent when nothing changed (a save that retyped the same number)
   * and when the field is cleared -- an emptied resi is a correction in
   * progress, not news she can act on.
   */
  const before = rows[0]
  if (!before) return
  const next = trackingNumber.trim()
  const previous = before.tracking_number.trim()
  if (!next || next === previous) return

  const events = [...new Set(rows.map((r) => r.event))]
  const where = events.length > 1 ? events.join(" and ") : events[0]
  await notifyCustomer(before.customer, {
    title: previous ? `Tracking number for ${where} changed` : `Tracking number for ${where}`,
    body: previous
      ? `Your parcel is now travelling under ${next}. The number we gave you before, ${previous}, no longer applies.`
      : `Your parcel from ${where} is travelling under ${next}. You can follow it from your order.`,
  }, db)
}

/**
 * Replace (or clear, when `tempAddress` is null) the one-time receiving address
 * on a shipment. Mirrors updateTrackingNumber's merge_group propagation: a
 * merged "Ship together" package is one physical box with one address, so
 * editing any row of the merge updates every row.
 */
export async function updateShipmentTempAddress(
  rowNumber: number,
  tempAddress: string | null,
  db: DBExecutor = sql,
): Promise<void> {
  const value = tempAddress && tempAddress.trim() ? tempAddress : null
  await db`
    UPDATE shipments
    SET temp_address = ${value}, updated_at = NOW()
    WHERE id = ${rowNumber}
       OR merge_group = (SELECT merge_group FROM shipments WHERE id = ${rowNumber} AND merge_group IS NOT NULL)
  `
}

// ─── Arrival List ──────────────────────────────────────────────────────────

export interface ArrivalListOrder {
  id: number
  customer: string
  unitBuy: number
  unitArrive: number
  pending: number
  /** Tracking ref this order's units were dispatched under (see the Dispatch List's
   *  "Inventory receipt" field). Empty when dispatched without one. */
  dispatchReceipt: string
  /** When it left, ISO date. Empty for lines dispatched before this was
   *  recorded. The receiving list reads it to show how long a parcel has been
   *  travelling, and to mark one that is overdue for its route. */
  dispatchedAt: string
}

export interface ArrivalListItem {
  event: string
  productId: number
  productName: string
  store: string
  totalPending: number   // remaining to arrive
  totalBought: number    // full quantity we bought (for partial-state display)
  // No customers[], orderIds[] or customerCount: every one of them was a
  // re-statement of `orders`, which has to be sent anyway. Two were arrays that
  // grew with the order count, and the screen rebuilt both from `orders` rather
  // than reading them. The valas/kurs/currency trio went the same way — added
  // for a cargo document that reads its figures elsewhere.
  orders: ArrivalListOrder[]
}

/**
 * Items that have been dispatched (unit_dispatch IS NOT NULL) but haven't fully
 * arrived yet (unit_arrive IS NULL OR unit_arrive < unit_dispatch) — you can only
 * receive what was dispatched. Grouped by event + product, with the per-customer
 * order list nested for the mark-arrived modal.
 */
export async function getArrivalList(event?: string, route?: string): Promise<ArrivalListItem[]> {
  const ev = event ?? null
  // "all" and undefined both mean unfiltered; anything else names a route, and
  // "other" names the absence of one.
  const rt = route && route !== "all" ? route : null

  // The route a parcel travelled is read off the front of its receipt, longest
  // code first so a specific code beats a shorter one that happens to be its
  // start. Resolving it here rather than in the browser is what lets a tab
  // fetch its own parcels instead of all of them.
  const pending = sql`
    SELECT o.id, o.event, o.product_id, o.customer, o.unit_dispatch, o.unit_arrive,
           o.dispatch_receipt, o.dispatched_at,
           COALESCE(rt.route_key, 'other') AS route_key
      FROM orders o
      LEFT JOIN LATERAL (
        SELECT dp.route_key
          FROM dispatch_route_prefixes dp
         WHERE upper(btrim(COALESCE(o.dispatch_receipt, ''))) LIKE dp.prefix || '%'
         ORDER BY length(dp.prefix) DESC
         LIMIT 1
      ) rt ON TRUE
     WHERE o.unit_dispatch IS NOT NULL
       AND (o.unit_arrive IS NULL OR o.unit_arrive < o.unit_dispatch)
       AND (${ev}::text IS NULL OR o.event = ${ev})
  `

  // Arrival gates on unit_dispatch (dispatched stock is what can be received);
  // 'unitBuy' JSON key carries the dispatched count.
  //
  // The quantities and the customer list are rebuilt from whatever survives the
  // route filter, never from the whole order: nine units of which five flew
  // must read as five on the air tab, or somebody hunts the bench for four
  // boxes that are still at sea.
  const itemsQuery = sql`
    WITH pending AS (${pending})
    SELECT
      pd.event,
      pd.product_id,
      p.name AS product_name,
      p.store,
      SUM(pd.unit_dispatch - COALESCE(pd.unit_arrive, 0))::int AS total_pending,
      SUM(pd.unit_dispatch)::int AS total_bought,
      JSON_AGG(JSON_BUILD_OBJECT(
        'id', pd.id,
        'customer', pd.customer,
        'unitBuy', pd.unit_dispatch,
        'unitArrive', COALESCE(pd.unit_arrive, 0),
        'pending', pd.unit_dispatch - COALESCE(pd.unit_arrive, 0),
        'dispatchReceipt', COALESCE(pd.dispatch_receipt, ''),
        'dispatchedAt', COALESCE(to_char(pd.dispatched_at, 'YYYY-MM-DD'), '')
      ) ORDER BY pd.customer, pd.id) AS orders
      FROM pending pd
      JOIN products p ON p.id = pd.product_id
      LEFT JOIN events e ON e.name = pd.event
     WHERE (${rt}::text IS NULL OR pd.route_key = ${rt})
     GROUP BY pd.event, pd.product_id, p.name, p.store
    HAVING SUM(pd.unit_dispatch - COALESCE(pd.unit_arrive, 0)) > 0
     -- Most recently created event first (matches the shopping list and
     -- dashboard); product name then store within each event. MAX() because
     -- created_at is constant per event but not in the GROUP BY. With one event
     -- selected this collapses to name-then-store, which is what that view wants.
     ORDER BY MAX(e.created_at) DESC NULLS LAST, pd.event, p.name, p.store
  `

  const rows = await itemsQuery

  const items: ArrivalListItem[] = rows.map((r) => ({
    event: r.event as string,
    productId: r.product_id as number,
    productName: r.product_name as string,
    store: r.store as string,
    totalPending: r.total_pending as number,
    totalBought: r.total_bought as number,
    orders: r.orders as ArrivalListOrder[],
  }))

  // Order each product's customers by allocation priority (paid → partial →
  // unpaid, then earliest order) so the arrive modal's fill preview matches the
  // server-side allocation in markProductArrived.
  // Sorted by it, never sent with it: the receiving table shows no per-customer
  // payment state, so the status is the server's business and the order of the
  // array carries everything the arrive modal needs.
  const statusMap = await fetchPaidStatusMap(event ? [event] : null)
  for (const item of items) {
    item.orders.sort(compareOrderPriority(item.event, statusMap))
  }

  return items
}

// ─── Excess (overbuy) Arrival Pending ──────────────────────────────────────
//
// excess_purchase rows dispatched but not yet arrived. Mirrors
// getExcessDispatchPending one stage later — see lib/db/dispatch.ts.

export async function getExcessArrivalPending(event?: string): Promise<ExcessTransitItem[]> {
  const rows = event
    ? await sql`
        WITH product_store AS (SELECT name, MIN(store) AS store FROM products GROUP BY name)
        SELECT e.id, e.event, e.items, e.reason, e.unit_buy,
               COALESCE(e.unit_dispatch, 0) AS unit_dispatch,
               COALESCE(e.unit_arrive, 0) AS unit_arrive,
               e.receipt, COALESCE(ps.store, '') AS store
        FROM excess_purchase e
        LEFT JOIN product_store ps ON ps.name = e.items
        WHERE e.unit_dispatch IS NOT NULL
          AND (e.unit_arrive IS NULL OR e.unit_arrive < e.unit_dispatch)
          AND e.event = ${event}
        ORDER BY e.id ASC
      `
    : await sql`
        WITH product_store AS (SELECT name, MIN(store) AS store FROM products GROUP BY name)
        SELECT e.id, e.event, e.items, e.reason, e.unit_buy,
               COALESCE(e.unit_dispatch, 0) AS unit_dispatch,
               COALESCE(e.unit_arrive, 0) AS unit_arrive,
               e.receipt, COALESCE(ps.store, '') AS store
        FROM excess_purchase e
        LEFT JOIN product_store ps ON ps.name = e.items
        WHERE e.unit_dispatch IS NOT NULL
          AND (e.unit_arrive IS NULL OR e.unit_arrive < e.unit_dispatch)
        ORDER BY e.id ASC
      `
  return rows.map((r) => ({
    rowNumber: r.id as number,
    event: r.event as string,
    items: r.items as string,
    store: r.store as string,
    reason: r.reason as ExcessReason,
    unitBuy: r.unit_buy as number,
    unitDispatch: r.unit_dispatch as number,
    unitArrive: r.unit_arrive as number,
    pending: (r.unit_dispatch as number) - (r.unit_arrive as number),
    receipt: (r.receipt as string) ?? "",
  }))
}

// ─── Received Report ───────────────────────────────────────────────────────

export interface ReceivedReportItem {
  event: string
  dispatchReceipt: string
  store: string
  productId: number
  productName: string
  unitsReceived: number
}

/**
 * Per-(dispatch_receipt, product) tally of units *received* for one event,
 * optionally narrowed to a local (Asia/Jakarta) date range (inclusive on both
 * ends). `event` is required; pass `from`/`to` as null (or omit) to include
 * every date for that event. Pass the same value for `from` and `to` for a
 * single day. Rows are split by the order's dispatch_receipt, so the same
 * product received under two receipts becomes two rows.
 *
 * Receiving is incremental — `unit_arrive` accumulates in batches and only
 * bumps `updated_at`, which any edit also touches — so `orders` itself can't
 * say what arrived on a date. Instead we read the append-only `audit.audit_log`
 * (migration 029): each orders write stores old/new JSONB, so the per-row delta
 * `new.unit_arrive − old.unit_arrive` is exactly the units booked in that
 * transaction. Summing the positive deltas gives the receipts.
 *
 * Only increases count (gross receipts): a downward correction that fixes an
 * over-count is intentionally excluded — this is a "what came in" log, not a
 * net-change log. `from`/`to` are 'YYYY-MM-DD' strings compared against the
 * audit timestamp converted to Asia/Jakarta, so day boundaries match the wall
 * clock rather than UTC.
 */
export async function getReceivedReport(
  event: string,
  from?: string | null,
  to?: string | null,
  /**
   * Narrow the report to one parcel, matched on the front of the receipt so
   * "MNC" gives every sea box and "MNC-3109" gives one. Case is ignored, since
   * the code is typed by hand while packing.
   */
  receipt?: string | null,
): Promise<ReceivedReportItem[]> {
  // Apply the date window only when a range was given; otherwise every receipt
  // for the event is included regardless of date.
  const dateFilter =
    from && to
      ? sql`AND (a.at AT TIME ZONE 'Asia/Jakarta')::date BETWEEN ${from}::date AND ${to}::date`
      : sql``
  const receiptFilter = receipt?.trim()
    ? sql`AND upper(COALESCE(a.new_row->>'dispatch_receipt', '')) LIKE ${`${receipt.trim().toUpperCase()}%`}`
    : sql``
  const rows = await sql`
    SELECT
      (a.new_row->>'event')                                        AS event,
      (a.new_row->>'product_id')::int                              AS product_id,
      p.name                                                       AS product_name,
      p.store                                                      AS store,
      COALESCE(a.new_row->>'dispatch_receipt', '')                 AS dispatch_receipt,
      SUM( (a.new_row->>'unit_arrive')::int
           - COALESCE((a.old_row->>'unit_arrive')::int, 0) )::int  AS units_received
    FROM audit.audit_log a
    JOIN products p ON p.id = (a.new_row->>'product_id')::int
    WHERE a.table_name = 'orders'
      AND a.action IN ('INSERT', 'UPDATE')
      AND (a.new_row->>'event') = ${event}
      ${dateFilter}
      ${receiptFilter}
      AND COALESCE((a.new_row->>'unit_arrive')::int, 0)
          > COALESCE((a.old_row->>'unit_arrive')::int, 0)
    GROUP BY event, product_id, p.name, p.store, dispatch_receipt
    ORDER BY event, dispatch_receipt, p.name
  `

  return rows.map((r) => ({
    event: r.event as string,
    dispatchReceipt: (r.dispatch_receipt as string) ?? "",
    store: (r.store as string) ?? "",
    productId: r.product_id as number,
    productName: r.product_name as string,
    unitsReceived: r.units_received as number,
  }))
}

/**
 * Partial allocation: shipments arrive in batches, so an order can have
 * unit_arrive < unit_dispatch and still appear in the arrival list with
 * reduced pending qty. Gates/caps on unit_dispatch (not unit_buy) — only
 * dispatched stock is eligible to be marked arrived.
 */
export async function markProductArrived(data: {
  event: string
  productId: number
  quantityArrived: number
  /**
   * The box being unpacked, when one is named.
   *
   * A box holds UNITS, not people. The items inside are loose and identical, so
   * whoever is next in the queue can be served from whatever box is open — and
   * that is the point: the queue is paid-first, and until now it could not
   * reach across boxes, so whoever the packer happened to put in the first box
   * was served first no matter who had paid.
   *
   * Naming the box does not restrict who may be filled. It says which box the
   * units came out of, so the boxes' outstanding counts can be kept true: this
   * one now owes that many fewer, and the customers still waiting are moved on
   * to the boxes that still owe them. Without that, a box you had emptied would
   * go on showing lines as pending.
   *
   * Undefined -- the All tab -- fills the same way and re-stamps nothing, since
   * no single box was opened.
   */
  receipt?: string
}, actor?: string | null): Promise<{
  filledOrderIds: number[]
  unassignedUnits: number
  /** What the paperwork said was in the opened box, when one was named. */
  boxExpected?: number
  /** How many more units were marked than that box was carrying. */
  markedBeyondBox?: number
}> {
  type Row = {
    id: number; customer: string; unitDispatch: number; unitArrive: number
    pending: number; receipt: string
  }
  const openedBox = (data.receipt ?? "").trim()
  const orders = (await sql`
    SELECT
      o.id,
      o.customer,
      o.unit_dispatch::int AS "unitDispatch",
      COALESCE(o.unit_arrive, 0)::int AS "unitArrive",
      (o.unit_dispatch - COALESCE(o.unit_arrive, 0))::int AS pending,
      COALESCE(o.dispatch_receipt, '') AS receipt
    FROM orders o
    WHERE o.event = ${data.event}
      AND o.product_id = ${data.productId}
      AND o.unit_dispatch IS NOT NULL
      AND (o.unit_arrive IS NULL OR o.unit_arrive < o.unit_dispatch)
    ORDER BY o.id ASC
  `) as unknown as Row[]

  // What each box still owes, before anything is taken out of this one. The
  // sum of these is the total still to arrive.
  const owedByBox = new Map<string, number>()
  for (const o of orders) owedByBox.set(o.receipt, (owedByBox.get(o.receipt) ?? 0) + o.pending)

  // Allocate arrivals to paid customers first, then partial, then unpaid
  // (earliest order within a tier). Matches the arrive modal's preview ordering.
  const statusMap = await fetchPaidStatusMap([data.event])
  orders.sort(compareOrderPriority(data.event, statusMap))

  const { allocations, excess: unassignedUnits } = allocateFifo(orders, (o) => o.pending, data.quantityArrived)
  const filledOrderIds: number[] = []

  // What this box was carrying, on paper. Marking more than that is allowed --
  // loose packing means a box really can hold more than the list says, and
  // refusing would leave stock in hand and nowhere to put it. But it is worth
  // saying out loud, because the other possibility is a miscount, and then a
  // box that lands later brings a unit nobody is waiting for.
  const boxExpected = openedBox ? (owedByBox.get(openedBox) ?? 0) : undefined
  const markedBeyondBox = openedBox
    ? Math.max(0, allocations.reduce((n, a) => n + a.allocated, 0) - (boxExpected ?? 0))
    : undefined

  if (allocations.length > 0) {
    const allocatedBy = new Map(allocations.map(({ item, allocated }) => [item.id, allocated]))
    const taken = allocations.reduce((n, a) => n + a.allocated, 0)

    // Take what was received out of the opened box's debt, and out of the other
    // boxes only if it owed less than turned up -- which happens when somebody
    // packs more into a box than the paperwork said.
    if (openedBox) {
      let left = taken
      const fromOpened = Math.min(left, owedByBox.get(openedBox) ?? 0)
      owedByBox.set(openedBox, (owedByBox.get(openedBox) ?? 0) - fromOpened)
      left -= fromOpened
      for (const [box, owed] of [...owedByBox].sort((a, b) => b[1] - a[1])) {
        if (left <= 0) break
        const off = Math.min(left, owed)
        owedByBox.set(box, owed - off)
        left -= off
      }
    }

    // Who is still waiting, and for how many, once this arrival is applied.
    const stillWaiting = orders
      .map((o) => ({ o, left: o.pending - (allocatedBy.get(o.id) ?? 0) }))
      .filter(({ left }) => left > 0)

    // Move each waiting line onto a box that still owes units. Her own box
    // first when it still owes -- nobody should be shuffled for no reason --
    // then whichever box has the most left. This is what empties a box you have
    // finished with: the people it can no longer serve move on to the boxes
    // that will.
    const reassign = new Map<number, string>()
    if (openedBox) {
      // A line with nothing left to come was served out of the box just opened,
      // so that is where its units came from and what it should say. While a
      // line is still waiting the receipt means the opposite -- the box that
      // owes it -- which is handled below. One field, two jobs, because a box
      // has nothing more to tell a customer it has finished serving.
      for (const { o, left } of stillWaiting) {
        // Her own box first when it still owes what she is waiting for: nobody
        // should be shuffled for no reason. Otherwise whichever box has most
        // left to give.
        let box = (owedByBox.get(o.receipt) ?? 0) >= left ? o.receipt : ""
        if (!box) {
          const [best] = [...owedByBox].filter(([, owed]) => owed >= left).sort((a, b) => b[1] - a[1])
          box = best?.[0] ?? o.receipt
        }
        owedByBox.set(box, (owedByBox.get(box) ?? 0) - left)
        // Compare against what the row will say AFTER the fill, not what it
        // said before. A part-filled line has already been stamped with the
        // opened box by the write above -- so a line that should go back to
        // waiting on its own box needs that written explicitly, or it is left
        // pointing at the box that has already given all it had.
        const afterFill = (allocatedBy.get(o.id) ?? 0) > 0 && openedBox ? openedBox : o.receipt
        if (box !== afterFill) reassign.set(o.id, box)
      }
    }

    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`

      // The received report reads the audit log, and credits a box by whatever
      // the row SAID at the moment unit_arrive rose (see getReceivedReport). So
      // the fill is written with the opened box on the row -- these units did
      // come out of it -- and any move onto a different box happens in a second
      // write, which the report ignores because unit_arrive did not change.
      for (const { item: o, allocated } of allocations) {
        const newUnitArrive = o.unitArrive + allocated
        if (newUnitArrive >= o.unitDispatch) filledOrderIds.push(o.id)
        if (openedBox && o.receipt !== openedBox) {
          await tx`
            UPDATE orders
            SET unit_arrive = ${newUnitArrive}, dispatch_receipt = ${openedBox}, updated_at = NOW()
            WHERE id = ${o.id}
          `
        } else {
          await tx`
            UPDATE orders
            SET unit_arrive = ${newUnitArrive}, updated_at = NOW()
            WHERE id = ${o.id}
          `
        }
      }
      for (const [orderId, box] of reassign) {
        await tx`
          UPDATE orders SET dispatch_receipt = ${box}, updated_at = NOW()
          WHERE id = ${orderId}
        `
      }
      // Whatever just landed for a customer who asked to hold this event is
      // parked with the rest, rather than becoming quietly shippable.
      await reapplyHoldsForArrival(data.event, allocations.map(({ item }) => item.customer), tx)
    })
  }

  // The plan moved: what travels now versus later has just changed, and a
  // stale fee is a wrong invoice. Priced per customer this arrival touched,
  // never the whole event — another customer's adjustment is not its business.
  // After the transaction, because the reconciler prices what is now true.
  //
  // Several at a time, not one after another: each reconcile is half a dozen
  // round trips, and one arrival on 30 Aug 2026 touched twenty customers — a
  // hundred and twenty sequential queries inside a single request, with the
  // receiving list waiting on all of them. They do not read each other's work,
  // so the order was never load-bearing.
  //
  // Four at a time rather than all of them: the pool holds twenty connections
  // for the whole dashboard, and an arrival that grabbed every one would make
  // everybody else's page wait instead. Most of the speed, none of the
  // starvation.
  const toReconcile = [...new Set(allocations.map(({ item }) => item.customer))]
  const RECONCILE_AT_ONCE = 4
  for (let i = 0; i < toReconcile.length; i += RECONCILE_AT_ONCE) {
    await Promise.all(
      toReconcile.slice(i, i + RECONCILE_AT_ONCE)
        .map((customer) => reconcileParcelPlan(customer, data.event)),
    )
  }

  return { filledOrderIds, unassignedUnits, boxExpected, markedBeyondBox }
}

export interface NotReceivedResult {
  cancelledUnits: number
  excessUnits: number
  /** Empty for a customer cancellation, and for anyone who had not paid. */
  refunds: { customer: string; amount: number; refundId: number }[]
}

/**
 * Bulk "Not Received": record a delivery problem against `qty` units of one
 * event+product. Allocates those units across the waiting orders by cancelling
 * unpaid orders first (paid customers protected) — the reverse of
 * markProductArrived, which fills paid customers first — with partial-order
 * cancellation; leftover (pending − qty) units stay pending. Refunds
 * auto-materialize as invoices drop. Inventory logging depends on mode:
 *   - broken / missing → log qty units flagged that reason (unassignable)
 *   - wrong            → log qty units of the received SKU as wrong_product (assignable)
 * Manages its own transaction + actor, mirroring markProductArrived.
 */
export async function recordNotReceived(
  data: {
    event: string
    productId: number
    productName: string
    qty: number
    mode: "wrong" | "broken" | "missing"
    receivedItem?: string
    /**
     * Only consider these orders.
     *
     * The Arrival List can either name a quantity and let it fall where
     * priority says, or let staff pick whose orders it comes off. Both mean the
     * same thing to the books — this many units leave — so both run through
     * here. Picking narrows the candidates; it never changes the rule that only
     * the marked quantity goes.
     */
    orderIds?: number[]
  },
  actor?: string | null,
): Promise<NotReceivedResult> {
  if (!(data.qty >= 1)) throw new Error("qty must be at least 1")
  if (data.mode === "wrong") {
    if (!data.receivedItem?.trim()) throw new Error("receivedItem is required for a wrong delivery")
    if (data.receivedItem === data.productName) throw new Error("Received item must differ from the expected item")
  }

  type Row = { id: number; customer: string; unitBuy: number; unitShip: number; unitPrice: number; pending: number }
  const orders = (await sql`
    SELECT id, customer,
           COALESCE(unit_buy, 0)::int  AS "unitBuy",
           COALESCE(unit_ship, 0)::int AS "unitShip",
           COALESCE(unit_price, 0)::int AS "unitPrice",
           -- Cap at the ordered unit count: a manual over-dispatch (unit_dispatch > unit)
           -- must never let us cancel/refund more units than the customer ordered.
           LEAST(unit_dispatch - COALESCE(unit_arrive, 0), unit)::int AS pending
    FROM orders
    WHERE event = ${data.event}
      AND product_id = ${data.productId}
      AND unit_dispatch IS NOT NULL
      AND (unit_arrive IS NULL OR unit_arrive < unit_dispatch)
      AND (${data.orderIds ?? null}::int[] IS NULL OR id = ANY(${data.orderIds ?? []}))
    ORDER BY id ASC
  `) as unknown as Row[]

  const statusMap = await fetchPaidStatusMap([data.event])
  // Cancel LOWEST-priority (unpaid) orders first on a shortage, protecting
  // paid customers — mirrors shopping-list's out-of-stock reduction (the
  // reverse of markProductArrived, which fills paid customers first).
  orders.sort(compareOrderPriority(data.event, statusMap)).reverse()

  const { allocations, excess } = allocateFifo(orders, (o) => o.pending, data.qty)
  if (excess > 0) throw new Error(`Only ${data.qty - excess} units are pending; cannot record ${data.qty}`)

  let cancelledUnits = 0
  const reductions: MarkReduction[] = []
  // What one of these units is worth, and weighs. The refund is measured from
  // her invoice, but bounded by this reduction's own cost -- marks do not run
  // one at a time, and a measurement taken across a shared invoice will happily
  // count a neighbouring mark's goods as its own.
  const [prod] = (await sql`
    SELECT COALESCE(gram, 0)::int AS gram FROM products WHERE id = ${data.productId}
  `) as unknown as { gram: number }[]
  const gramPerUnit = prod?.gram ?? 0
  // Before anything moves: what each of them is billed today. The refund is
  // capped by the difference this mark makes to that, which is how the ongkir
  // riding on the removed goods comes back with them.
  const totalsBefore = await invoiceTotalsNow(data.event)
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`
    for (const { item: o, allocated } of allocations) {
      cancelledUnits += allocated
      reductions.push({ customer: o.customer, unitsRemoved: allocated, unitPrice: o.unitPrice, gramPerUnit })
      await reduceOrderRefundOnly({ orderId: o.id, qty: allocated }, tx)
    }
    if (data.mode === "broken" || data.mode === "missing") {
      await appendExcessPurchase(
        [{ event: data.event, items: data.productName, unitBuy: data.qty, receipt: "", reason: data.mode }],
        tx,
      )
    } else {
      await appendExcessPurchase(
        [{ event: data.event, items: data.receivedItem!, unitBuy: data.qty, receipt: "", reason: "wrong_product", expectedItem: data.productName }],
        tx,
      )
    }
  })

  // A cancellation is the customer's own doing and has its own flow — it
  // creates no refund here. The other three each carry the reason somebody
  // knew at the moment they marked it.
  const REASON_FOR: Record<typeof data.mode, string | null> = {
    missing: "shipping_loss",
    broken: "damaged",
    wrong: "wrong_item",
  }
  const reason = REASON_FOR[data.mode]

  // Fewer units means a different parcel plan, whether or not anyone is
  // splitting: what is invoiced has changed underneath it. Before the refund is
  // priced, not after -- it moves the invoice too, and a refund settled against
  // a total that is about to change is settled against the wrong one.
  for (const customer of [...new Set(reductions.map((r) => r.customer))]) {
    await reconcileParcelPlan(customer, data.event)
  }

  // Now the invoice has finished moving: what is owed depends on where it
  // landed, and on how far it fell.
  const refunds = reason
    ? await refundForReduction(
        data.event, reason, data.productName, reductions, totalsBefore, actor, data.receivedItem)
    : []

  const excessUnits = data.qty
  return { cancelledUnits, excessUnits, refunds }
}


/**
 * Give a parcel its real tracking number.
 *
 * Packing runs ahead of paperwork: a box goes out as "MNC - box 1" and the
 * courier's number arrives hours or days later. Renaming has to move every
 * line of that parcel at once — the receipt IS the parcel, so leaving half the
 * lines under the old code would split one box into two on screen.
 *
 * Already-received lines are renamed too. They were in the same box, and the
 * receipt is how anyone would look that up afterwards.
 *
 * dispatched_at is untouched: this is a correction to a label, not a second
 * departure, and the clock on the receiving list must keep counting from when
 * the box actually left.
 *
 * Returns how many lines moved, so the caller can tell "renamed" from "that
 * parcel no longer exists" — two people editing the same box, most likely.
 */
export async function renameDispatchReceipt(
  from: string, to: string, db: DBExecutor = sql,
): Promise<{ moved: number }> {
  const oldReceipt = from.trim()
  const newReceipt = to.trim()
  if (!oldReceipt) throw new Error("The parcel to rename is required")
  if (!newReceipt) throw new Error("A tracking number is required")
  if (oldReceipt === newReceipt) return { moved: 0 }

  const rows = await db`
    UPDATE orders SET dispatch_receipt = ${newReceipt}, updated_at = NOW()
    WHERE dispatch_receipt = ${oldReceipt}
    RETURNING id
  `
  // Ready-stock lines travel in the same boxes and carry the same codes.
  const excess = await db`
    UPDATE excess_purchase SET dispatch_receipt = ${newReceipt}, updated_at = NOW()
    WHERE dispatch_receipt = ${oldReceipt}
    RETURNING id
  `
  return { moved: rows.length + excess.length }
}
