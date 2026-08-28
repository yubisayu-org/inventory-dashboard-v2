import { randomUUID } from "node:crypto"
import postgres from "postgres"
import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { normalizeId } from "./helpers"
import { holdPackingList, releasePackingList } from "./fulfillment"

// The customer's own shipping choices for her events. See migration 105 for
// the shape and why it is not on `shipments`.

export type ShipMode = "wait" | "split" | "hold"

export type ShippingPref = {
  event: string
  mode: ShipMode
  /** Who chose it. Her page can then say the shop arranged this rather than
   *  showing her a decision she does not remember making -- while still
   *  letting her undo it, which is the point of showing it at all. */
  setBy: SetBy
  mergeKey: string | null
  tempAddress: string | null
  /** The Biteship area chosen alongside it, when there is one. */
  tempAreaId: string | null
  tempAreaName: string | null
}

/** Why an event cannot be chosen for, when it cannot. */
export type Ineligible = "unpaid" | "shipped" | "unknown"

const MODES: ShipMode[] = ["wait", "split", "hold"]

export function isShipMode(v: unknown): v is ShipMode {
  return typeof v === "string" && (MODES as string[]).includes(v)
}

type PrefRow = {
  event: string
  mode: ShipMode
  set_by: SetBy
  merge_key: string | null
  temp_address: string | null
  temp_area_id: string | null
  temp_area_name: string | null
}

const toPref = (r: PrefRow): ShippingPref => ({
  event: r.event,
  mode: r.mode,
  setBy: r.set_by,
  mergeKey: r.merge_key,
  tempAddress: r.temp_address,
  tempAreaId: r.temp_area_id,
  tempAreaName: r.temp_area_name,
})

export async function getShippingPrefs(
  customerId: number,
  db: postgres.Sql | DBExecutor = sql,
): Promise<ShippingPref[]> {
  const rows = await db<PrefRow[]>`
    SELECT event, mode, set_by, merge_key, temp_address, temp_area_id, temp_area_name
      FROM customer_shipping_prefs
     WHERE customer_id = ${customerId}
  `
  return rows.map(toPref)
}

/**
 * Whether this customer may choose anything for this event.
 *
 * Two bars, both about facts the customer cannot argue with:
 *
 *  - **Paid.** Every choice here moves a parcel or splits a delivery fee, and
 *    an unsettled order is not hers to route yet. Read from the same per-event
 *    invoice arithmetic the customer's own Order history shows, so the gate and
 *    the balance she is looking at can never disagree.
 *  - **Not gone.** Once every unit has shipped there is nothing left to decide.
 *
 * Returns null when the event is fine, or the reason it is not.
 */
export async function ineligibleReason(
  customerId: number,
  event: string,
  db: DBExecutor = sql,
): Promise<Ineligible | null> {
  const [row] = await db<
    {
      units: string
      shipped: string
      subtotal: string
      gram: string
      paid: string
      adjustments: string
      ongkir: string
    }[]
  >`
    WITH me AS (
      SELECT instagram_id, lower(replace(instagram_id, '@', '')) AS cust_key
        FROM customers WHERE id = ${customerId}
    ),
    lines AS (
      SELECT COALESCE(SUM(o.unit), 0) AS units,
             COALESCE(SUM(o.unit_ship), 0) AS shipped,
             COALESCE(SUM(o.unit_price * o.unit), 0) AS subtotal,
             COALESCE(SUM(COALESCE(p.gram, 0) * o.unit), 0) AS gram
        FROM orders o
        JOIN products p ON p.id = o.product_id
        JOIN me ON lower(replace(o.customer, '@', '')) = me.cust_key
       WHERE o.event = ${event}
    )
    SELECT lines.units, lines.shipped, lines.subtotal, lines.gram,
           COALESCE((SELECT SUM(amount) FROM payments pay, me
                      WHERE pay.event = ${event} AND pay.is_checked
                        AND lower(replace(pay.customer, '@', '')) = me.cust_key), 0) AS paid,
           COALESCE((SELECT SUM(amount) FROM adjustments adj, me
                      WHERE adj.event = ${event}
                        AND lower(replace(adj.customer, '@', '')) = me.cust_key), 0) AS adjustments,
           COALESCE((SELECT cwo.ongkos_kirim
                       FROM events ev
                       JOIN customer_warehouse_ongkir cwo ON cwo.warehouse_id = ev.warehouse_id
                      WHERE ev.name = ${event} AND cwo.customer_id = ${customerId}), 0) AS ongkir
      FROM lines
  `

  const units = Number(row?.units ?? 0)
  if (units <= 0) return "unknown"
  if (Number(row.shipped) >= units) return "shipped"

  // Same arithmetic as customer_invoice_summary: subtotal + ongkir per rounded
  // kilo + adjustments, against what has been paid.
  const kg = Math.ceil(Number(row.gram) / 1000)
  const invoiced = Number(row.subtotal) + Number(row.ongkir) * kg + Number(row.adjustments)
  const outstanding = invoiced - Number(row.paid)
  // Paid or overpaid. A zero invoice is settled by definition.
  return outstanding > 0 ? "unpaid" : null
}

/** How much of an event has shipped, for the guards that care. */
async function shippedUnits(customerId: number, event: string, db: DBExecutor): Promise<number> {
  const [row] = await db<{ shipped: string }[]>`
    SELECT COALESCE(SUM(o.unit_ship), 0) AS shipped
      FROM orders o
      JOIN customers c ON c.id = ${customerId}
     WHERE o.event = ${event}
       AND lower(replace(o.customer, '@', '')) = lower(replace(c.instagram_id, '@', ''))
  `
  return Number(row?.shipped ?? 0)
}

/** Who set a shipping preference. The shop is not a customer. */
export type SetBy = "customer" | "shop"

/**
 * Whether a refusal applies to this caller.
 *
 * "shipped" and "unknown" are facts about the world and stop everyone.
 * "unpaid" is a rule about what a customer may do on her own account, and the
 * shop inherits it only by accident: a merge is arranged precisely while she
 * still owes, so the saving reaches the invoice she settles — and a split
 * could otherwise never be undone, because its own fee is what makes her
 * unpaid.
 *
 * Shipping keeps its own payment gate. This decides who may write down a plan,
 * not who may send a box.
 */
function blocks(reason: Ineligible | null, setBy: SetBy): boolean {
  if (!reason) return false
  return !(setBy === "shop" && reason === "unpaid")
}

export class ShippingPrefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ShippingPrefError"
  }
}

/**
 * Set one event's mode, and apply it where applying is the point.
 *
 * `hold` calls holdPackingList immediately: it is reversible, and waiting on
 * approval to NOT ship something would be theatre. `split` deliberately does
 * not ship anything — it commits the customer to a second delivery fee and the
 * shop to a trip to the courier, so it is flagged and the shop presses the
 * button.
 *
 * Note this runs on the MAIN pool rather than catalogue_public: holding writes
 * orders.unit_hold, which that role has no business being able to touch. The
 * scoping is in the checks above instead — session-derived customer, ownership,
 * payment, and shipment state, all verified before anything is written.
 */
export async function setShippingMode(
  customerId: number,
  event: string,
  mode: ShipMode,
  db: DBExecutor = sql,
  /** Who chose it. The shop recording a plan is not the customer asking. */
  setBy: SetBy = "customer",
): Promise<void> {
  const reason = await ineligibleReason(customerId, event, db)
  if (blocks(reason, setBy)) throw new ShippingPrefError(reason!)

  // A half-shipped event cannot be held by the customer: the queue and the
  // parcel that already left would disagree about what is outstanding. The shop
  // parks the remainder of a part-shipped card as a matter of course, and did
  // so before this went through here at all.
  if (mode === "hold" && setBy === "customer" && (await shippedUnits(customerId, event, db)) > 0) {
    throw new ShippingPrefError("part-shipped")
  }

  const [customer] = await db<{ instagram_id: string }[]>`
    SELECT instagram_id FROM customers WHERE id = ${customerId}`
  if (!customer) throw new ShippingPrefError("unknown")

  const previous = (await getShippingPrefs(customerId, db)).find((p) => p.event === event)

  await db`
    INSERT INTO customer_shipping_prefs (customer_id, event, mode, set_by)
    VALUES (${customerId}, ${event}, ${mode}, ${setBy})
    ON CONFLICT (customer_id, event)
    DO UPDATE SET mode = ${mode}, set_by = ${setBy}, updated_at = NOW()
  `

  if (mode === "hold") {
    await holdPackingList({ customer: customer.instagram_id, event })
  } else if (previous?.mode === "hold") {
    // Leaving hold by any door releases it. Otherwise a customer who switches
    // to "wait" stays invisibly held, and the shop never sees the order again.
    await releasePackingList({ customer: customer.instagram_id, event })
  }
}

/**
 * Let a held order go: free the units and forget the wish, together.
 *
 * Coming out of hold is two facts, not one. `unit_hold` parks the units off the
 * packing list, and `mode = 'hold'` is a standing instruction that outlives the
 * moment it was given -- reapplyHoldsForArrival reads it on every arrival, so
 * anything that lands afterwards is parked again.
 *
 * These used to be two calls, and the caller had to remember both. Releasing
 * once did only the first: the units came free, the order came back on the
 * packing list, and it looked finished -- then the next box to land re-parked
 * the lot, hours later, through an action nobody would connect to the release.
 * The second half was added to fix exactly that, which left a pair that must
 * always be called together and a half that still works on its own.
 *
 * One call now. Her own "wait" goes through setShippingMode and always did
 * both; this is the same thing for the shop, which additionally skips the
 * eligibility check -- the shop must be able to let a parcel go whatever the
 * queue thinks of it.
 *
 * The row's mode is only touched where it says `hold`. A merge_key lives in the
 * same row and parks the parcel for a different reason; clearing that would
 * un-pair the trips and take the merge discount off her invoice with it.
 *
 * The packing list is freed unconditionally, even where there is no prefs row
 * to clear: a hold set before any of this existed still has units to release.
 */
export async function releaseHold(
  customerId: number | null,
  customer: string,
  event: string,
  db: DBExecutor = sql,
  /** Who let it go. The shop releasing is not the customer changing her mind. */
  setBy: SetBy = "shop",
): Promise<void> {
  await releasePackingList({ customer, event }, db)
  if (customerId == null) return
  await db`
    UPDATE customer_shipping_prefs
       SET mode = 'wait', set_by = ${setBy}, updated_at = NOW()
     WHERE customer_id = ${customerId} AND event = ${event} AND mode = 'hold'
  `
}

/**
 * Put these events in one box, or take one out of its group.
 *
 * Every event named has to be eligible in its own right — a customer cannot
 * route an unpaid order by attaching it to a paid one. Passing a list of one,
 * or an empty list, clears the group: a group of one is not a group.
 */
export async function setMergeGroup(
  customerId: number,
  events: string[],
  db: DBExecutor = sql,
  /** Who arranged it. The shop merging its own boxes is not the customer asking. */
  setBy: SetBy = "customer",
): Promise<string | null> {
  const wanted = Array.from(new Set(events.filter((e) => typeof e === "string" && e.trim())))

  for (const event of wanted) {
    const reason = await ineligibleReason(customerId, event, db)
    if (blocks(reason, setBy)) throw new ShippingPrefError(reason!)
  }

  const prefs = await getShippingPrefs(customerId, db)
  // Whatever these events were previously grouped with is being replaced, so
  // their old partners have to be released too — otherwise a two-event group
  // that loses a member leaves the other paired with nobody.
  const touchedKeys = new Set(
    prefs.filter((p) => wanted.includes(p.event) && p.mergeKey).map((p) => p.mergeKey as string),
  )
  const orphans = prefs
    .filter((p) => p.mergeKey && touchedKeys.has(p.mergeKey) && !wanted.includes(p.event))
    .map((p) => p.event)

  const key = wanted.length >= 2 ? randomUUID() : null

  const [customer] = await db<{ instagram_id: string }[]>`
    SELECT instagram_id FROM customers WHERE id = ${customerId}`
  if (!customer) throw new ShippingPrefError("unknown")

  // One transaction, so a group is never half-formed: an event pointing at a
  // key its partner never got is worse than no grouping at all.
  await sql.begin(async (tx) => {
    for (const event of orphans) {
      await tx`
        UPDATE customer_shipping_prefs
           SET merge_key = NULL, updated_at = NOW()
         WHERE customer_id = ${customerId} AND event = ${event}`
    }
    for (const event of wanted) {
      await tx`
        INSERT INTO customer_shipping_prefs (customer_id, event, merge_key, set_by)
        VALUES (${customerId}, ${event}, ${key}, ${setBy})
        ON CONFLICT (customer_id, event)
        DO UPDATE SET merge_key = ${key}, set_by = ${setBy}, updated_at = NOW()`
    }
  })

  // Pairing parks the parcels. Without this the paired events sit in Siap
  // Kirim looking like any other order, and one bulk ship breaks the pairing
  // with nobody told. Combining is what lets them go again.
  const prefsNow = await getShippingPrefs(customerId, db)
  const modeOf = (e: string) => prefsNow.find((p) => p.event === e)?.mode
  for (const event of wanted) {
    await holdPackingList({ customer: customer.instagram_id, event })
  }
  for (const event of orphans) {
    // An outright hold is a separate wish and survives losing its partner.
    if (modeOf(event) !== "hold") {
      await releasePackingList({ customer: customer.instagram_id, event })
    }
  }
  // Naming one event, or none, is how a pairing is undone.
  if (!key) {
    for (const event of wanted) {
      if (modeOf(event) !== "hold") {
        await releasePackingList({ customer: customer.instagram_id, event })
      }
    }
  }

  return key
}

/**
 * A one-off receiving address for this parcel. An empty street clears the
 * whole thing, area included.
 *
 * The area is optional but arrives with the address, not instead of it: an
 * area alone is not somewhere a courier can deliver, and a street alone is
 * the free-text destination the picker exists to prevent. Passing an area
 * without a street therefore clears both, same as passing nothing.
 */
export async function setTempAddress(
  customerId: number,
  event: string,
  input: { address: string; areaId?: string | null; areaName?: string | null },
  db: DBExecutor = sql,
  /** Who recorded it. The shop writing down what she said on WhatsApp is not
   *  the customer choosing from her own page. */
  setBy: SetBy = "customer",
): Promise<void> {
  // The payment bar is a rule about customers, and a redirect is usually asked
  // for early -- before the trip is settled, often before anything has arrived.
  // Refusing the shop there would refuse it exactly when it is useful.
  const reason = await ineligibleReason(customerId, event, db)
  if (blocks(reason, setBy)) throw new ShippingPrefError(reason!)

  const value = input.address.trim() ? input.address.trim() : null
  const areaId = value && input.areaId?.trim() ? input.areaId.trim() : null
  const areaName = value && areaId && input.areaName?.trim() ? input.areaName.trim() : null
  await db`
    INSERT INTO customer_shipping_prefs (customer_id, event, temp_address, temp_area_id, temp_area_name, set_by)
    VALUES (${customerId}, ${event}, ${value}, ${areaId}, ${areaName}, ${setBy})
    ON CONFLICT (customer_id, event)
    DO UPDATE SET temp_address = ${value}, temp_area_id = ${areaId},
                  temp_area_name = ${areaName}, set_by = ${setBy}, updated_at = NOW()
  `
}

/** Staff view: what this customer has asked for, by event. */
export async function shippingPrefsForCustomer(
  instagramId: string,
  db: DBExecutor = sql,
): Promise<ShippingPref[]> {
  const key = normalizeId(instagramId)
  const rows = await db<PrefRow[]>`
    SELECT sp.event, sp.mode, sp.set_by, sp.merge_key, sp.temp_address, sp.temp_area_id, sp.temp_area_name
      FROM customer_shipping_prefs sp
      JOIN customers c ON c.id = sp.customer_id
     WHERE lower(replace(c.instagram_id, '@', '')) = ${key}
  `
  return rows.map(toPref)
}
