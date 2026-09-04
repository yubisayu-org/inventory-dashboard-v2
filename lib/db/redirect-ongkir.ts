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

/**
 * What marks a charge as belonging to a parcel that has already gone.
 *
 * While a redirect is only asked for, its charge is a running estimate: she
 * changes the area, the row is rewritten. Once a box has actually left for it,
 * that money is spent and the row must never be rewritten again — otherwise a
 * second redirect on the same trip, which the split flow makes ordinary, would
 * overwrite the first parcel's charge and quietly refund a delivery that
 * really happened.
 */
const SETTLED = " · terkirim"

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
  destinationName: string
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
      destination_name: string | null
      usual_per_kg: string | null
      weight_kg: string | null
    }[]
  >`
    SELECT c.instagram_id AS customer,
           w.biteship_area_id AS origin_area_id,
           sp.temp_area_id AS destination_area_id,
           sp.temp_area_name AS destination_name,
           cwo.effective_ongkir AS usual_per_kg,
           sp.mode AS mode,
           -- The box this redirect is actually for, not everything she
           -- ordered. Sending early means the box carries what has arrived, so
           -- that is what it is priced on — the same basis the split fee she
           -- was already quoted uses. Waiting means the box carries whatever
           -- has not gone yet.
           --
           -- Each rounded on its own, because each is its own parcel: a 4.5 kg
           -- box is charged as five whether or not the rest of the order would
           -- have rounded differently.
           CEIL(COALESCE(SUM(
             p.gram * GREATEST(
               CASE WHEN sp.mode = 'split'
                    THEN LEAST(COALESCE(o.unit_arrive, 0), o.unit) - COALESCE(o.unit_ship, 0)
                    ELSE o.unit - COALESCE(o.unit_ship, 0)
               END, 0)
           ), 0)::numeric / 1000) AS weight_kg
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
     GROUP BY c.instagram_id, w.biteship_area_id, sp.temp_area_id, sp.temp_area_name,
              cwo.effective_ongkir, sp.mode
  `
  if (!row) return null
  return {
    customer: row.customer,
    originAreaId: row.origin_area_id,
    destinationAreaId: row.destination_area_id,
    destinationName: String(row.destination_name ?? ""),
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
       -- A parcel has taken this one. It is history, not a running total.
       AND description NOT LIKE ${`%${SETTLED}%`}
     ORDER BY id LIMIT 1`
  return row ?? null
}

/**
 * The parcel has gone to the address it was redirected to, so its charge stops
 * being editable and a later redirect on the same trip starts a new one.
 *
 * Called from the dispatch path, beside the clearing of the redirect itself:
 * the two are one event, and a charge left open after the box has left is a
 * charge the next redirect would silently take back.
 */
/**
 * The box has been packed and weighed, so the estimate becomes the bill.
 *
 * Everything before this point priced a box nobody had built yet: what had
 * arrived when she chose, at the grams the product list claims. This prices
 * the parcel that is actually leaving, at the kilos it is actually billed for
 * — and then settles it, because the money is spent.
 */
export async function finaliseRedirectCharge(
  customer: string,
  event: string,
  billedKg: number,
  db: DBExecutor = sql,
): Promise<void> {
  const [row] = await db<{ per_kg: number | null; usual: string | null; area: string | null }[]>`
    SELECT sp.temp_ongkir_per_kg AS per_kg,
           cwo.effective_ongkir AS usual,
           sp.temp_area_name AS area
      FROM customer_shipping_prefs sp
      JOIN customers c ON c.id = sp.customer_id
      JOIN events ev ON ev.name = sp.event
      LEFT JOIN customer_warehouse_ongkir cwo
        ON cwo.customer_id = c.id AND cwo.warehouse_id = ev.warehouse_id
     WHERE sp.event = ${event}
       AND lower(replace(c.instagram_id, '@', '')) = lower(replace(${customer}, '@', ''))`

  // No rate means the courier never priced this area, and nothing was charged
  // for it. A box leaving does not change that.
  if (!row || row.per_kg == null) return

  const delta = (Number(row.per_kg) - Number(row.usual ?? 0)) * Math.max(0, Math.ceil(billedKg))
  const existing = await findCharge(customer, event, db)

  if (delta === 0) {
    if (existing) await db`DELETE FROM adjustments WHERE id = ${existing.id}`
    return
  }

  const where = row.area ? ` — ${String(row.area).split(",")[0].trim()}` : ""
  const description = `${TAG}${where} (${Math.ceil(billedKg)} kg)`
  if (existing) {
    await db`
      UPDATE adjustments SET description = ${description}, amount = ${delta}, updated_at = NOW()
       WHERE id = ${existing.id}`
  } else {
    await db`
      INSERT INTO adjustments (event, customer, description, amount, auto)
      VALUES (${event}, ${customer}, ${description}, ${delta}, true)`
  }
}

export async function settleRedirectCharge(
  customer: string,
  event: string,
  db: DBExecutor = sql,
): Promise<void> {
  const existing = await findCharge(customer, event, db)
  if (!existing) return
  const stamp = new Date().toISOString().slice(0, 10)
  await db`
    UPDATE adjustments
       SET description = description || ${`${SETTLED} ${stamp}`}, updated_at = NOW()
     WHERE id = ${existing.id}`
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

  // Named, because a split can put two of these on one invoice and "Ongkir
  // alamat berbeda" twice tells her nothing about which box was which.
  const where = facts.destinationName ? ` — ${facts.destinationName.split(",")[0].trim()}` : ""
  const description = `${TAG}${where} (${facts.weightKg} kg)`
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

/**
 * The address changed after the parcel was already on the Shipments list.
 *
 * Pressing Ship does not put a box on a van: the parcels are packed one at a
 * time, and a customer asking for somewhere else in that gap is ordinary. The
 * correction is priced like any other — what her invoice should carry for this
 * parcel, minus what it already carries — so a second correction cannot double
 * the first, and a street being retyped changes nothing at all because only
 * the area is priced.
 *
 * Returns what it would do. `apply` is what makes it happen, so the dialog can
 * show a person the figure and let them decide.
 */
export async function repriceShippedRedirect(
  shipmentRow: number,
  destinationAreaId: string,
  destinationAreaName: string,
  apply: boolean,
  db: DBExecutor = sql,
): Promise<{ perKg: number | null; previousPerKg: number; weightKg: number; delta: number } | null> {
  const [ship] = await db<
    {
      event: string
      customer: string
      billed_kg: string | null
      usual_per_kg: string | null
      origin_area_id: string | null
      current_area_id: string
    }[]
  >`
    SELECT s.event, s.customer,
           s.weight_estimation AS billed_kg,
           -- What this parcel's ongkir was billed at: her standing rate for
           -- the trip, which is the baseline every redirect surcharge on it
           -- has been measured against.
           s.ongkir AS usual_per_kg,
           w.biteship_area_id AS origin_area_id,
           s.temp_area_id AS current_area_id
      FROM shipments s
      JOIN events ev ON ev.name = s.event
      LEFT JOIN warehouses w ON w.id = ev.warehouse_id
     WHERE s.id = ${shipmentRow}
  `
  if (!ship || !ship.origin_area_id) return null

  const weightKg = Math.max(0, Math.ceil(Number(ship.billed_kg ?? 0)))
  const usualPerKg = Number(ship.usual_per_kg ?? 0)
  const perKg = await quotePerKg(ship.origin_area_id, destinationAreaId)
  if (perKg === null) {
    return { perKg: null, previousPerKg: usualPerKg, weightKg, delta: 0 }
  }

  // What this parcel's redirect surcharge should come to in total, against
  // everything already charged for redirecting it — settled rows included,
  // because those are exactly what "already charged" means.
  const [{ charged }] = await db<{ charged: string | null }[]>`
    SELECT SUM(amount) AS charged FROM adjustments
     WHERE event = ${ship.event}
       AND lower(replace(customer, '@', '')) = lower(replace(${ship.customer}, '@', ''))
       AND auto AND description LIKE ${`${TAG}%`}`
  const already = Number(charged ?? 0)
  const target = (perKg - usualPerKg) * weightKg
  const delta = target - already

  if (!apply || delta === 0) {
    return { perKg, previousPerKg: usualPerKg, weightKg, delta }
  }

  const stamp = new Date().toISOString().slice(0, 10)
  const where = destinationAreaName ? ` — ${destinationAreaName.split(",")[0].trim()}` : ""
  await db`
    INSERT INTO adjustments (event, customer, description, amount, auto)
    VALUES (${ship.event}, ${ship.customer},
            ${`${TAG}${where} (${weightKg} kg) · koreksi ${stamp}`}, ${delta}, true)`

  await announce(ship.customer, ship.event,
    delta > 0 ? "inbox_ongkir_extra" : "inbox_ongkir_credit", Math.abs(delta), db)

  return { perKg, previousPerKg: usualPerKg, weightKg, delta }
}
