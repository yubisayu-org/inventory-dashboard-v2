import sql from "../db-pool"
import { withActor, type DBExecutor } from "./actor"
import { normalizeId, parcelPlanExtra } from "./helpers"
import { sendInvoiceNotice } from "./notices"
import { fillNotice, NOTICE_TEMPLATES } from "../notice-templates"

export type PlanRow = { description: string; amount: number }

/**
 * The adjustment a plan is owed, or null when it is owed nothing.
 *
 * Zero is silence rather than a zero-amount row: the rounding absorbs most
 * splits, and a line reading "Rp 0" on somebody's invoice is a question she
 * should not have to ask.
 *
 * The credit keeps the owner's own wording. "Gabung ongkir dengan LSFT202607"
 * says which trip the parcel merged with; a bare "Diskon ongkir" leaves her
 * guessing six weeks later.
 */
export function planAdjustment(extra: number, partnerEvent: string | null): PlanRow | null {
  if (extra === 0) return null
  if (extra > 0) return { description: "Ongkir kirim duluan", amount: extra }
  return {
    description: partnerEvent ? `Gabung ongkir dengan ${partnerEvent}` : "Diskon gabung ongkir",
    amount: extra,
  }
}

const rupiah = (n: number) => `Rp ${new Intl.NumberFormat("id-ID").format(Math.abs(n))}`

/**
 * Tell her what changed, and why.
 *
 * Load-bearing rather than courteous: she never sees an adjustment's
 * description. The WhatsApp invoice adds every adjustment into one "Biaya
 * Lainnya" line and her catalogue page reads three aggregates from a view
 * where adjustments are not readable at all. Without this she sees a number
 * that grew and has to ask.
 */
async function announce(
  event: string,
  customer: string,
  row: PlanRow,
  db: DBExecutor,
): Promise<void> {
  const key = row.amount > 0 ? "inbox_ongkir_extra" : "inbox_ongkir_credit"
  const template = NOTICE_TEMPLATES.find((t) => t.key === key)!
  const tokens = { "{event}": event, "{customer}": customer, "{amount}": rupiah(row.amount) }
  await sendInvoiceNotice({
    event,
    customer,
    title: fillNotice(template.title, tokens),
    body: fillNotice(template.body, tokens),
  }, db)
}

/**
 * Make the system's adjustment equal what this customer's plan now costs.
 *
 * Derived state, not an event. Un-merging is not an undo path — it is this
 * function reaching a different number — which is why there is no history to
 * unwind and no ordering to get wrong. A customer who merges, splits, and
 * changes her mind twice ends up with exactly the row her final plan is owed.
 *
 * Scoped to one customer: a reconcile triggered by one person's arrival must
 * never rewrite another's row.
 *
 * What it cannot see: a parcel that has already gone. The orders it reads no
 * longer contain it, so a plan declared after the first box has left prices
 * only what is still pending. That under-charges rather than double-charges,
 * and the fee written when the plan WAS declared is held by the in-flight rule
 * below — which is the half that costs real money if it goes wrong.
 *
 * Returns the row as it now stands, or null when the plan costs nothing.
 */
export async function reconcileParcelPlan(
  customer: string,
  event: string,
  db: DBExecutor = sql,
): Promise<PlanRow | null> {
  const key = normalizeId(customer)

  // Every trip in this customer's plan: the named one, plus anything sharing
  // its merge group. A pairing is priced as one parcel, so the group has to be
  // gathered before the arithmetic rather than after.
  const trips = (await db`
    WITH me AS (
      SELECT id FROM customers WHERE lower(replace(instagram_id, '@', '')) = ${key}
    ),
    grp AS (
      SELECT merge_key FROM customer_shipping_prefs
       WHERE customer_id = (SELECT id FROM me) AND event = ${event}
         AND merge_key IS NOT NULL
    )
    SELECT p.event, p.mode, p.merge_key
      FROM customer_shipping_prefs p
     WHERE p.customer_id = (SELECT id FROM me)
       AND (p.event = ${event}
            OR (p.merge_key IS NOT NULL AND p.merge_key = (SELECT merge_key FROM grp)))
  `) as unknown as { event: string; mode: string | null; merge_key: string | null }[]

  const events = trips.length ? [...new Set(trips.map((t) => t.event))] : [event]
  const merged = trips.some((t) => t.merge_key) && events.length > 1
  const splitting = trips.some((t) => t.mode === "split")

  const [rate] = (await db`
    SELECT COALESCE(cwo.ongkos_kirim, 0)::int AS ongkir
      FROM events ev
      JOIN customer_warehouse_ongkir cwo ON cwo.warehouse_id = ev.warehouse_id
      JOIN customers c ON c.id = cwo.customer_id
     WHERE ev.name = ${event}
       AND lower(replace(c.instagram_id, '@', '')) = ${key}
  `) as unknown as { ongkir: number }[]
  const ongkirPerKg = Number(rate?.ongkir ?? 0)

  const lines = (await db`
    SELECT o.event, COALESCE(p.gram, 0)::int AS gram, o.unit::int AS unit,
           -- What actually travels in the early parcel. Only a declared split
           -- sends part of an order; otherwise the whole line goes at once.
           GREATEST(COALESCE(o.unit_arrive, 0) - COALESCE(o.unit_ship, 0), 0)::int AS arrived
      FROM orders o JOIN products p ON p.id = o.product_id
     WHERE o.event = ANY(${events})
       AND lower(replace(o.customer, '@', '')) = ${key}
       AND o.unit > 0
  `) as unknown as { event: string; gram: number; unit: number; arrived: number }[]

  const byEvent = new Map<string, { gram: number; unit: number; toShip: number }[]>()
  for (const l of lines) {
    const list = byEvent.get(l.event) ?? []
    list.push({ gram: l.gram, unit: l.unit, toShip: splitting ? Math.min(l.arrived, l.unit) : l.unit })
    byEvent.set(l.event, list)
  }

  const all = [...byEvent.values()]
  const invoicedKg = all.reduce(
    (kg, l) => kg + Math.ceil(l.reduce((g, x) => g + x.gram * x.unit, 0) / 1000), 0)

  // A merge is one parcel for the whole group, so its weight is summed before
  // rounding rather than after — which is exactly where the saving comes from.
  const extra = merged
    ? ongkirPerKg * (Math.ceil(all.flat().reduce((g, x) => g + x.gram * x.unit, 0) / 1000) - invoicedKg)
    : parcelPlanExtra(all.map((l) => ({ lines: l })), ongkirPerKg)

  const partner = merged ? events.filter((e) => e !== event).sort()[0] ?? null : null
  const wanted = planAdjustment(extra, partner)

  // Has any of this plan already travelled?
  //
  // A parcel that has gone was paid for at the price agreed when it was
  // declared, and this function prices what is true now — where a shipped box
  // no longer appears. So from the first shipment the figure may still rise, if
  // the plan grew, but it may never fall: taking money back for a journey that
  // happened is the one mistake here that cannot be undone by pressing the
  // button again.
  const [sent] = (await db`
    SELECT COALESCE(SUM(unit_ship), 0)::int AS shipped
      FROM orders
     WHERE event = ANY(${events}) AND lower(replace(customer, '@', '')) = ${key}
  `) as unknown as { shipped: number }[]
  const inFlight = (sent?.shipped ?? 0) > 0

  // Only ever its own row. A description matching by accident is not enough —
  // see the test that plants one.
  const [existing] = (await db`
    SELECT id, description, amount::int AS amount FROM adjustments
     WHERE event = ${event} AND lower(replace(customer, '@', '')) = ${key}
       AND auto AND description NOT LIKE 'Selisih ongkir JNE%'
     ORDER BY id LIMIT 1
  `) as unknown as { id: number; description: string; amount: number }[]

  if (!wanted) {
    // Nothing owed by today's arithmetic — but if a box has gone, today's
    // arithmetic is not the whole story.
    if (existing && !inFlight) await db`DELETE FROM adjustments WHERE id = ${existing.id}`
    return existing && inFlight
      ? { description: existing.description, amount: existing.amount }
      : null
  }
  if (!existing) {
    await db`
      INSERT INTO adjustments (event, customer, description, amount, auto)
      VALUES (${event}, ${customer}, ${wanted.description}, ${wanted.amount}, true)`
    await announce(event, customer, wanted, db)
    return wanted
  }
  // Downwards is refused once a parcel has left; upwards is still allowed,
  // because a plan that grew after the first box is genuinely owed more.
  if (inFlight && wanted.amount < existing.amount) {
    return { description: existing.description, amount: existing.amount }
  }
  if (existing.amount !== wanted.amount || existing.description !== wanted.description) {
    await db`
      UPDATE adjustments
         SET description = ${wanted.description}, amount = ${wanted.amount}, updated_at = NOW()
       WHERE id = ${existing.id}`
    // Only when the figure actually moved. This runs on every arrival, and
    // telling her the same thing four times is worse than not telling her.
    if (existing.amount !== wanted.amount) await announce(event, customer, wanted, db)
  }
  return wanted
}

/**
 * What the courier actually charged for a parcel, when it disagreed with the
 * estimate.
 *
 * NULL means it did not — most parcels — and nothing is recorded. A weight
 * equal to the estimate is the same thing said differently, and is stored
 * without producing a row.
 *
 * The difference is its own adjustment rather than an edit to the split fee.
 * They answer different questions — what splitting cost, and what the estimate
 * missed — and folded into one number, a change in either would be
 * indistinguishable.
 */
export async function recordChargedWeight(
  shipmentId: number,
  chargedKg: number | null,
  actor?: string | null,
): Promise<void> {
  await withActor(actor ?? null, async (tx) => {
    const [s] = (await tx`
      UPDATE shipments SET weight_charged = ${chargedKg}, updated_at = NOW()
       WHERE id = ${shipmentId}
      RETURNING event, customer, weight_estimation::int AS estimated, ongkir::int AS rate
    `) as unknown as { event: string; customer: string; estimated: number; rate: number }[]
    if (!s) throw new Error("Shipment not found")

    const difference = chargedKg === null ? 0 : (chargedKg - s.estimated)
    const amount = difference * s.rate

    const [existing] = (await tx`
      SELECT id, amount::int AS amount FROM adjustments
       WHERE event = ${s.event} AND customer = ${s.customer}
         AND auto AND description LIKE 'Selisih ongkir JNE%'
       ORDER BY id LIMIT 1
    `) as unknown as { id: number; amount: number }[]

    if (amount === 0) {
      if (existing) await tx`DELETE FROM adjustments WHERE id = ${existing.id}`
      return
    }

    const description = `Selisih ongkir JNE (${s.estimated} kg → ${chargedKg} kg)`
    if (existing) {
      if (existing.amount === amount) return
      await tx`
        UPDATE adjustments SET description = ${description}, amount = ${amount}, updated_at = NOW()
         WHERE id = ${existing.id}`
    } else {
      await tx`
        INSERT INTO adjustments (event, customer, description, amount, auto)
        VALUES (${s.event}, ${s.customer}, ${description}, ${amount}, true)`
    }

    // Same rule as every other automatic change, and it matters more here:
    // this one lands after her parcel has already left.
    const template = NOTICE_TEMPLATES.find((t) => t.key === "inbox_ongkir_reweighed")!
    const tokens = {
      "{event}": s.event,
      "{customer}": s.customer,
      "{amount}": rupiah(amount),
      "{chargedKg}": String(chargedKg),
      "{estimatedKg}": String(s.estimated),
    }
    await sendInvoiceNotice({
      event: s.event,
      customer: s.customer,
      title: fillNotice(template.title, tokens),
      body: fillNotice(template.body, tokens),
    }, tx)
  })
}
