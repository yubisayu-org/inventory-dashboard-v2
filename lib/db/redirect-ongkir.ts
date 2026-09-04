import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { courierRates, BiteshipNotConfiguredError } from "../biteship"
import { fillNotice, NOTICE_TEMPLATES, type NoticeKey } from "../notice-templates"
import { sendInvoiceNotice } from "./notices"

/**
 * What it costs to send a parcel somewhere other than where she lives.
 *
 * Her standing ongkir is priced for her own area. A redirect to another one
 * may cost more or less, and until now the difference was surfaced for a
 * person to judge and, in practice, never applied — the shop billed the old
 * rate and hoped the gap was small.
 *
 * So the redirect prices itself: the courier is asked what it charges to the
 * new area, the difference against her usual rate is multiplied by this
 * parcel's weight, and the result becomes an ordinary automatic adjustment on
 * that trip. The same shape reweighing already uses — one row per customer per
 * trip, updated in place, removed when the reason for it goes away — so every
 * screen that already reads adjustments reads this without being taught to.
 *
 * Nothing here may take a redirect down with it. She asked for her parcel to
 * go somewhere; a courier API that times out is not a reason to refuse her.
 */

/** How the row identifies itself, so it can be found again and updated. */
const TAG = "Ongkir alamat berbeda"

/** A quote is asked for one kilo — the shop's own rates are per kilo, so that
 *  is the only comparison that is like for like. */
const QUOTE_WEIGHT_GRAMS = 1000

export interface RedirectPricing {
  /** The courier's rate per kg to the redirected area, or null when it would
   *  not quote one. */
  perKg: number | null
  /** What her own address is charged per kg on this trip. */
  usualPerKg: number
  /** Rounded up, the way every invoice on this system rounds it. */
  weightKg: number
  /** perKg and usualPerKg differ by this much across the whole parcel. */
  delta: number
}

interface Facts {
  customer: string
  originAreaId: string | null
  destinationAreaId: string | null
  usualPerKg: number
  weightKg: number
}

/** Everything the price depends on, read in one go. */
async function factsFor(customerId: number, event: string, db: DBExecutor): Promise<Facts | null> {
  const [row] = await db<
    {
      customer: string
      origin_area_id: string | null
      destination_area_id: string | null
      usual_per_kg: string | null
      weight_kg: string | null
    }[]
  >`
    SELECT c.instagram_id AS customer,
           w.biteship_area_id AS origin_area_id,
           sp.temp_area_id AS destination_area_id,
           cwo.effective_ongkir AS usual_per_kg,
           -- The same rounding the invoice quotes with: a 1.2 kg parcel is
           -- charged as two, so a redirect must be priced as two as well.
           CEIL(COALESCE(SUM(p.gram * o.unit), 0)::numeric / 1000) AS weight_kg
      FROM customers c
      JOIN customer_shipping_prefs sp
        ON sp.customer_id = c.id AND sp.event = ${event}
      JOIN events ev ON ev.name = sp.event
      LEFT JOIN warehouses w ON w.id = ev.warehouse_id
      LEFT JOIN customer_warehouse_ongkir cwo
        ON cwo.customer_id = c.id AND cwo.warehouse_id = ev.warehouse_id
      LEFT JOIN orders o
        ON o.event = sp.event
       AND lower(replace(o.customer, '@', '')) = lower(replace(c.instagram_id, '@', ''))
      LEFT JOIN products p ON p.id = o.product_id
     WHERE c.id = ${customerId}
     GROUP BY c.instagram_id, w.biteship_area_id, sp.temp_area_id, cwo.effective_ongkir
  `
  if (!row) return null
  return {
    customer: row.customer,
    originAreaId: row.origin_area_id,
    destinationAreaId: row.destination_area_id,
    usualPerKg: Number(row.usual_per_kg ?? 0),
    weightKg: Number(row.weight_kg ?? 0),
  }
}

/**
 * What the courier charges per kilo to an area, or null.
 *
 * Null covers every reason at once — no key configured, the request failed,
 * the courier returned nothing for that area. All three mean the same thing to
 * everyone downstream: nobody may be charged for a figure we do not have.
 */
export async function quotePerKg(
  originAreaId: string,
  destinationAreaId: string,
): Promise<number | null> {
  try {
    const rates = await courierRates(originAreaId, destinationAreaId, QUOTE_WEIGHT_GRAMS)
    const priced = rates.map((r) => r.price).filter((n) => Number.isFinite(n) && n > 0)
    if (priced.length === 0) return null
    // The cheapest service, which is what the shop's own published rate is.
    return Math.min(...priced)
  } catch (err) {
    if (!(err instanceof BiteshipNotConfiguredError)) {
      console.error("Failed to quote a redirect:", err)
    }
    return null
  }
}

/**
 * Price a redirect and put the difference on her invoice.
 *
 * Called after the address is written, by whichever side wrote it. Returns
 * what it worked out so a caller can show it; returns null when there is
 * nothing redirected, which is also when any earlier charge is removed.
 */
export async function priceRedirect(
  customerId: number,
  event: string,
  db: DBExecutor = sql,
): Promise<RedirectPricing | null> {
  const facts = await factsFor(customerId, event, db)
  if (!facts) return null

  // Redirected nowhere, or nowhere the courier knows: no charge stands.
  if (!facts.destinationAreaId || !facts.originAreaId) {
    await clearCharge(facts.customer, event, db)
    await db`
      UPDATE customer_shipping_prefs SET temp_ongkir_per_kg = NULL
       WHERE customer_id = ${customerId} AND event = ${event}`
    return null
  }

  const perKg = await quotePerKg(facts.originAreaId, facts.destinationAreaId)
  await db`
    UPDATE customer_shipping_prefs SET temp_ongkir_per_kg = ${perKg}
     WHERE customer_id = ${customerId} AND event = ${event}`

  // A rate we could not get is not a rate of zero. Nothing is charged, and the
  // Ship screen says so rather than pretending the old rate still applies.
  if (perKg === null) {
    await clearCharge(facts.customer, event, db)
    return { perKg: null, usualPerKg: facts.usualPerKg, weightKg: facts.weightKg, delta: 0 }
  }

  const delta = (perKg - facts.usualPerKg) * facts.weightKg
  await applyCharge(facts.customer, event, delta, facts, db)
  return { perKg, usualPerKg: facts.usualPerKg, weightKg: facts.weightKg, delta }
}

/**
 * What a redirect to this area would cost, without changing anything.
 *
 * The sheet asks before she saves, because the note she has been reading for
 * weeks promises exactly that: we will quote the delivery for the new address
 * before you pay. Nothing is written and nothing is charged — that happens
 * when she saves, and priceRedirect asks the courier again rather than
 * trusting a figure that travelled through a browser.
 */
export async function previewRedirect(
  customerId: number,
  event: string,
  destinationAreaId: string,
  db: DBExecutor = sql,
): Promise<RedirectPricing | null> {
  const facts = await factsFor(customerId, event, db)
  if (!facts || !facts.originAreaId) return null

  const perKg = await quotePerKg(facts.originAreaId, destinationAreaId)
  return {
    perKg,
    usualPerKg: facts.usualPerKg,
    weightKg: facts.weightKg,
    delta: perKg === null ? 0 : (perKg - facts.usualPerKg) * facts.weightKg,
  }
}

/** The one automatic row this reason is allowed to own. */
async function findCharge(customer: string, event: string, db: DBExecutor) {
  const [row] = await db<{ id: number; amount: number }[]>`
    SELECT id, amount FROM adjustments
     WHERE event = ${event}
       AND lower(replace(customer, '@', '')) = lower(replace(${customer}, '@', ''))
       AND auto
       AND description LIKE ${`${TAG}%`}
     ORDER BY id LIMIT 1`
  return row ?? null
}

async function clearCharge(customer: string, event: string, db: DBExecutor): Promise<void> {
  const existing = await findCharge(customer, event, db)
  if (!existing) return
  await db`DELETE FROM adjustments WHERE id = ${existing.id}`
  await announce(customer, event, existing.amount > 0
    ? "inbox_ongkir_extra_cleared"
    : "inbox_ongkir_credit_cleared", Math.abs(existing.amount), db)
}

async function applyCharge(
  customer: string,
  event: string,
  delta: number,
  facts: Facts,
  db: DBExecutor,
): Promise<void> {
  const existing = await findCharge(customer, event, db)

  // The same area, or one that happens to cost the same: nothing to charge,
  // and any earlier charge is undone rather than left standing.
  if (delta === 0) {
    await clearCharge(customer, event, db)
    return
  }
  if (existing && existing.amount === delta) return

  const description = `${TAG} (${facts.weightKg} kg)`
  if (existing) {
    await db`
      UPDATE adjustments SET description = ${description}, amount = ${delta}, updated_at = NOW()
       WHERE id = ${existing.id}`
  } else {
    await db`
      INSERT INTO adjustments (event, customer, description, amount, auto)
      VALUES (${event}, ${customer}, ${description}, ${delta}, true)`
  }

  await announce(customer, event, delta > 0 ? "inbox_ongkir_extra" : "inbox_ongkir_credit",
    Math.abs(delta), db)
}

/** Money moved on her invoice, so she hears it from the shop. */
async function announce(
  customer: string,
  event: string,
  key: NoticeKey,
  amount: number,
  db: DBExecutor,
): Promise<void> {
  const template = NOTICE_TEMPLATES.find((t) => t.key === key)
  if (!template) return
  const tokens = {
    "{event}": event,
    "{customer}": customer,
    "{amount}": `Rp ${amount.toLocaleString("id-ID")}`,
  }
  try {
    await sendInvoiceNotice({
      event,
      customer,
      title: fillNotice(template.title, tokens),
      body: fillNotice(template.body, tokens),
    }, db)
  } catch (err) {
    // The charge is the thing that mattered and it is already written.
    console.error("Failed to announce a redirect's ongkir:", err)
  }
}
