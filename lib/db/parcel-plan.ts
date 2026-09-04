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
  /**
   * The row is going away rather than arriving. `row` is then what it USED to
   * say, which is the only thing worth telling her: the amount she is no
   * longer being charged, or no longer saving.
   */
  cleared = false,
): Promise<void> {
  const key = cleared
    ? (row.amount > 0 ? "inbox_ongkir_extra_cleared" : "inbox_ongkir_credit_cleared")
    : (row.amount > 0 ? "inbox_ongkir_extra" : "inbox_ongkir_credit")
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
    ),
    -- The plan is cleared when a merged box ships, and this used to be where
    -- the group vanished: reconciling afterwards saw unrelated trips, could
    -- not write a credit that was still missing, and could not maintain the
    -- ones already written. Somebody then found it on the invoices and typed
    -- it in — twelve times.
    --
    -- The parcel record does not forget. merge_group says which trips left in
    -- one box, and goes on saying it.
    shipped_grp AS (
      SELECT DISTINCT s.merge_group
        FROM shipments s
       WHERE s.merge_group IS NOT NULL
         AND lower(replace(s.customer, '@', '')) = ${key}
         AND s.event = ${event}
    )
    SELECT p.event, p.mode, p.merge_key
      FROM customer_shipping_prefs p
     WHERE p.customer_id = (SELECT id FROM me)
       AND (p.event = ${event}
            OR (p.merge_key IS NOT NULL AND p.merge_key = (SELECT merge_key FROM grp))
            OR p.event IN (
                 SELECT s2.event FROM shipments s2
                  WHERE s2.merge_group IN (SELECT merge_group FROM shipped_grp)
                    AND lower(replace(s2.customer, '@', '')) = ${key}))
  `) as unknown as { event: string; mode: string | null; merge_key: string | null }[]

  const events = trips.length ? [...new Set(trips.map((t) => t.event))] : [event]
  // Either signal makes a group: the plan while it is still a plan, and the
  // parcel once the box has gone.
  const merged = events.length > 1
  const splitting = trips.some((t) => t.mode === "split")

  const [rate] = (await db`
    SELECT COALESCE(cwo.effective_ongkir, 0)::int AS ongkir
      FROM events ev
      JOIN customer_warehouse_ongkir cwo ON cwo.warehouse_id = ev.warehouse_id
      JOIN customers c ON c.id = cwo.customer_id
     WHERE ev.name = ${event}
       AND lower(replace(c.instagram_id, '@', '')) = ${key}
  `) as unknown as { ongkir: number }[]
  const ongkirPerKg = Number(rate?.ongkir ?? 0)

  const lines = (await db`
    SELECT o.event, COALESCE(p.gram, 0)::int AS gram, o.unit::int AS unit,
           -- What is left to send. Units already gone are counted once, in the
           -- shipments above; counting them here as "still to come" as well is
           -- what made three boxes look like four.
           GREATEST(o.unit - COALESCE(o.unit_ship, 0), 0)::int AS remaining,
           -- What actually travels in the early parcel. Only a declared split
           -- sends part of an order; otherwise the whole line goes at once.
           GREATEST(COALESCE(o.unit_arrive, 0) - COALESCE(o.unit_ship, 0), 0)::int AS arrived
      FROM orders o JOIN products p ON p.id = o.product_id
     WHERE o.event = ANY(${events})
       AND lower(replace(o.customer, '@', '')) = ${key}
       AND o.unit > 0
  `) as unknown as { event: string; gram: number; unit: number; remaining: number; arrived: number }[]

  // Two views of the same lines. The invoice was written against everything
  // she ordered; the parcels still to come are only what has not gone yet.
  const invoicedByEvent = new Map<string, number>()
  const byEvent = new Map<string, { gram: number; unit: number; toShip: number }[]>()
  for (const l of lines) {
    invoicedByEvent.set(l.event, (invoicedByEvent.get(l.event) ?? 0) + l.gram * l.unit)
    const list = byEvent.get(l.event) ?? []
    list.push({
      gram: l.gram,
      unit: l.remaining,
      toShip: splitting ? Math.min(l.arrived, l.remaining) : l.remaining,
    })
    byEvent.set(l.event, list)
  }

  const all = [...byEvent.values()]
  const invoicedKg = [...invoicedByEvent.values()].reduce((kg, g) => kg + Math.ceil(g / 1000), 0)

  // Boxes that have already gone, in the kilos the courier billed for them.
  //
  // Without this the arithmetic judges each send on its own and asks "does
  // this fit inside what she paid?" — and answers yes every time, because the
  // parcels that already left are not in the orders any more. Three sends,
  // three yeses, and the shop quietly absorbs every kilo after the first.
  //
  // Read from the money, not the weight. weight_estimation is the raw figure
  // on most rows and the rounded one on the newest, and a merged shipment can
  // carry a weight with a zero total — the partner of a box somebody else's
  // row paid for. Dividing what was charged by the per-kilo rate gives the
  // kilos actually billed, on every row of either era, and gives a merge
  // partner the nothing it cost.
  const [sent] = (await db`
    SELECT COALESCE(SUM(
             CASE
               -- What was actually paid, where anything was paid.
               WHEN COALESCE(ongkir, 0) > 0 AND COALESCE(ongkir_total, 0) > 0
                 THEN ROUND(ongkir_total::numeric / ongkir)
               -- A merged partner's weight sits on the primary row.
               WHEN merge_group IS NOT NULL THEN 0
               -- Older rows kept the raw weight and no total; the courier
               -- rounded it up all the same.
               ELSE CEIL(COALESCE(weight_estimation, 0))
             END), 0)::int AS kg
      FROM shipments
     WHERE event = ANY(${events})
       AND lower(replace(customer, '@', '')) = ${key}
  `) as unknown as { kg: number }[]
  const sentKg = Number(sent?.kg ?? 0)

  // A merge is one parcel for the whole group, so its weight is summed before
  // rounding rather than after — which is exactly where the saving comes from.
  // The parcels still to come, each rounded up the way a courier charges.
  //
  // Counted here rather than through parcelPlanExtra: that function measures
  // a plan against the invoice itself, and here the invoice has to be compared
  // against the sent boxes too. Same rounding, one subtraction instead of two.
  const kg = (gram: number) => (gram > 0 ? Math.ceil(gram / 1000) : 0)
  const plannedKg = merged
    // One box for the whole group, so its weight is summed before rounding —
    // which is exactly where a merge saves anything.
    ? kg(all.flat().reduce((g, x) => g + x.gram * x.unit, 0))
    : all.reduce((total, lines) => {
        const now = lines.reduce((g, x) => g + x.gram * x.toShip, 0)
        const rest = lines.reduce((g, x) => g + x.gram * Math.max(0, x.unit - x.toShip), 0)
        return total + kg(now) + kg(rest)
      }, 0)

  // Everything the courier will have been paid for this trip, against the one
  // ongkir the invoice charged for it.
  const extra = ongkirPerKg * (sentKg + plannedKg - invoicedKg)

  const partner = merged ? events.filter((e) => e !== event).sort()[0] ?? null : null

  /**
   * The group saves once, so the group is credited once.
   *
   * `extra` above is the whole pairing's arithmetic -- every trip's weight
   * summed before rounding, against every trip's invoiced kilos. That figure
   * belongs to the pairing, not to whichever trip this call happens to name.
   * Writing it per event, and calling this once per event, credited a two-trip
   * merge twice: hanapanjaitan saved one kilo, Rp 14.000, and was given
   * Rp 28.000 across LSCN202606 and LSFT202607. A three-way merge would have
   * paid it three times.
   *
   * One trip of the group holds it, chosen by name so every call agrees on
   * which without needing to know who called first. The others reach
   * `wanted = null` here and delete their own row on the next reconcile --
   * unless a parcel has already gone, where the floor below refuses to take
   * money back for a journey that happened.
   */
  /**
   * The saving is credited where it was charged.
   *
   * Each trip's invoice charges delivery on its own rounded weight, so three
   * trips in one box are charged three times for a journey that happened once.
   * The difference is given back by cancelling whole delivery charges —
   * cheapest first — until what is still charged equals what the box actually
   * cost.
   *
   * Cheapest first, and partially where a whole charge would overshoot: a trip
   * billed 26.000 inside a group that saved 13.000 keeps half its charge. The
   * alternative, piling the whole saving onto one trip, produced invoices
   * whose total was less than the goods on them — 398.000 of items and a
   * 385.000 total, which is not a thing anybody should have to explain.
   *
   * Nothing ever gains a charge here. Splitting one box into several can only
   * cost more, never less, so there is always enough charge to give back.
   */
  // A parcel the shop gave away costs the customer nothing, so every charge on
  // the group is given back — through the same distribution a merge uses, which
  // is what keeps a gift from cancelling more than was charged.
  const [gift] = (await db`
    SELECT 1 AS free FROM shipments s
     WHERE s.free_shipping
       AND lower(replace(s.customer, '@', '')) = ${key}
       AND s.event = ANY(${events})
     LIMIT 1
  `) as unknown as { free: number }[]
  const givenAway = Boolean(gift)

  const charged = new Map<string, number>()
  for (const [e, gram] of invoicedByEvent) charged.set(e, ongkirPerKg * kg(gram))
  const boxCost = givenAway ? 0 : ongkirPerKg * (sentKg + plannedKg)
  const saving = [...charged.values()].reduce((n, c) => n + c, 0) - boxCost

  /**
   * How much of each trip's delivery she has already handed over.
   *
   * Payments minus goods: a trip she paid in full before the merge existed has
   * the delivery money sitting inside that payment, and a trip she paid goods
   * alone on has not. It decides which invoice keeps the charge when two are
   * charged the same — see below.
   */
  const covered = new Map<string, number>()
  if (merged) {
    const rows = (await db`
      WITH goods AS (
        SELECT o.event, SUM(o.unit_price * GREATEST(o.unit - COALESCE(o.unit_returned, 0), 0)) AS amount
          FROM orders o
         WHERE o.event = ANY(${events})
           AND lower(replace(o.customer, '@', '')) = ${key}
         GROUP BY 1
      ),
      paid AS (
        SELECT p.event, SUM(p.amount) AS amount
          FROM payments p
         WHERE p.event = ANY(${events})
           AND lower(replace(p.customer, '@', '')) = ${key}
           AND p.is_checked
         GROUP BY 1
      )
      SELECT g.event, (COALESCE(pd.amount, 0) - g.amount)::int AS covered
        FROM goods g LEFT JOIN paid pd ON pd.event = g.event
    `) as unknown as { event: string; covered: number }[]
    for (const r of rows) covered.set(r.event, Number(r.covered))
  }

  let mine = 0
  if ((merged || givenAway) && saving > 0) {
    let left = saving
    /**
     * Cheapest charge first — and where two are charged the same, the one she
     * has paid least toward.
     *
     * One box owes one delivery, and that money is usually already inside a
     * payment she made before the merge existed. Crediting that trip and
     * charging the other left her with a credit on one invoice and a debt on
     * the other of the same size, for somebody to move across by hand:
     * taleofblackcats, Rp 50.000 each way, and mutiasr, Rp 13.000. Crediting
     * the trip she has not paid the delivery on closes both.
     *
     * Name still settles a genuine tie, so every call agrees on the order
     * without knowing who called first.
     */
    const order = [...charged.entries()].sort((a, b) =>
      a[1] - b[1]
      || (covered.get(a[0]) ?? 0) - (covered.get(b[0]) ?? 0)
      || a[0].localeCompare(b[0]))
    for (const [e, charge] of order) {
      if (left <= 0) break
      const take = Math.min(charge, left)
      if (e === event) mine = take
      left -= take
    }
  }

  // A group that costs MORE than its invoices — an early box inside a
  // pairing — is one fee, not one per trip, and it lands on a single trip
  // chosen by name.
  const holder = merged ? [...events].sort()[0] : event
  const creditName = givenAway
    ? "Gratis ongkir"
    : partner ? `Gabung ongkir dengan ${partner}` : "Diskon gabung ongkir"

  const wanted = !merged && !givenAway
    ? planAdjustment(extra, partner)
    : saving > 0
      ? (mine > 0 ? { description: creditName, amount: -mine } : null)
      : (event === holder ? planAdjustment(extra, partner) : null)

  // A parcel that has gone was paid for at the price agreed then, and this
  // prices what is true now. The kilos are counted above, so the figure holds
  // on its own — but the rule stays as a floor: from the first shipment it may
  // rise, never fall. Taking money back for a journey that happened is the one
  // mistake here that pressing the button again cannot undo.
  // Either signal will do. Shipping writes both a shipments row and the units,
  // and a plan whose units have gone is in flight whether or not its paperwork
  // landed — the floor below is the last thing that should depend on a join.
  const shippedUnits = lines.reduce((n, l) => n + Math.max(0, l.unit - l.remaining), 0)
  const inFlight = sentKg > 0 || shippedUnits > 0

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
    if (existing && !inFlight) {
      await db`DELETE FROM adjustments WHERE id = ${existing.id}`
      // Told, the same as its arrival was. This branch used to be the silent
      // one: a merge announced its discount and an un-merge removed it without
      // a word, leaving the newest message in her inbox describing a saving
      // she no longer had. Insert and change both announce; going away is the
      // third thing that happens to this row and it is no less her business.
      await announce(event, customer, existing, db, true)
    }
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
      RETURNING event, customer, ongkir::int AS rate,
                -- What this parcel was billed at, not what it weighed: the
                -- stored weight is raw on older rows, and the difference the
                -- customer owes is a difference in kilos charged.
                CASE WHEN COALESCE(ongkir, 0) > 0 AND COALESCE(ongkir_total, 0) > 0
                     THEN ROUND(ongkir_total::numeric / ongkir)::int
                     ELSE CEIL(COALESCE(weight_estimation, 0))::int END AS estimated
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
    // Lighter than estimated is money back, not a charge — and it needs no
    // apology.
    const template = NOTICE_TEMPLATES.find((t) => t.key === (amount > 0
      ? "inbox_ongkir_reweighed"
      : "inbox_ongkir_reweighed_less"))!
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
