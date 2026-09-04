import { randomUUID } from "node:crypto"
import postgres from "postgres"
import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { normalizeId } from "./helpers"
import { holdPackingList, releasePackingList } from "./fulfillment"
import { sendInvoiceNotice } from "./notices"
import { fillNotice, NOTICE_TEMPLATES, type NoticeKey } from "../notice-templates"
import { priceRedirect } from "./redirect-ongkir"

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
  /** Who the courier should ask for. Empty means her own name and phone. */
  tempName: string
  tempPhone: string
  /** The courier's rate per kg to the redirected area. Null when nothing is
   *  redirected, or when the courier would not price it — and then nothing is
   *  charged either. */
  tempOngkirPerKg: number | null
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
  temp_name: string | null
  temp_phone: string | null
  temp_ongkir_per_kg: number | null
}

const toPref = (r: PrefRow): ShippingPref => ({
  event: r.event,
  mode: r.mode,
  setBy: r.set_by,
  mergeKey: r.merge_key,
  tempAddress: r.temp_address,
  tempAreaId: r.temp_area_id,
  tempAreaName: r.temp_area_name,
  // Empty means "her own", which is what every redirect before these columns
  // existed meant.
  tempName: r.temp_name ?? "",
  tempPhone: r.temp_phone ?? "",
  tempOngkirPerKg: r.temp_ongkir_per_kg ?? null,
})

export async function getShippingPrefs(
  customerId: number,
  db: postgres.Sql | DBExecutor = sql,
): Promise<ShippingPref[]> {
  const rows = await db<PrefRow[]>`
    SELECT event, mode, set_by, merge_key, temp_address, temp_area_id, temp_area_name,
           temp_name, temp_phone, temp_ongkir_per_kg
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
 *  - **Paid for.** The ITEMS, not the invoice. Every other charge on a trip —
 *    the delivery fee, an early-shipping extra, a courier reweigh — is a
 *    consequence of the very plan she is asking to change, so counting them
 *    would let one of her choices forbid the next. See ineligibleReason.
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
      paid: string
    }[]
  >`
    WITH me AS (
      SELECT instagram_id, lower(replace(instagram_id, '@', '')) AS cust_key
        FROM customers WHERE id = ${customerId}
    ),
    lines AS (
      -- Billed units: what she still owes for. A returned item stops
      -- counting toward the bar that decides whether she may direct the
      -- packing, because she is not being asked to pay for it.
      SELECT COALESCE(SUM(GREATEST(o.unit - COALESCE(o.unit_returned, 0), 0)), 0) AS units,
             COALESCE(SUM(o.unit_ship), 0) AS shipped,
             COALESCE(SUM(o.unit_price * GREATEST(o.unit - COALESCE(o.unit_returned, 0), 0)), 0) AS subtotal
        FROM orders o
        JOIN me ON lower(replace(o.customer, '@', '')) = me.cust_key
       WHERE o.event = ${event}
    )
    SELECT lines.units, lines.shipped, lines.subtotal,
           COALESCE((SELECT SUM(amount) FROM payments pay, me
                      WHERE pay.event = ${event} AND pay.is_checked
                        AND lower(replace(pay.customer, '@', '')) = me.cust_key), 0) AS paid
      FROM lines
  `

  const units = Number(row?.units ?? 0)
  if (units <= 0) return "unknown"
  if (Number(row.shipped) >= units) return "shipped"

  /*
   * Has she paid for the ITEMS?
   *
   * That is the whole question. It used to be "has she settled the invoice",
   * shipping and adjustments included, which is circular: every charge in
   * that total except the goods is a consequence of the plan she is trying to
   * change. Asking to send early adds a fee, the fee makes her unpaid, and
   * unpaid forbids the change — including changing her mind. Setting the
   * plan's own fee aside fixed that one case and left its neighbours: a
   * courier reweigh, a delivery fee not yet settled, anything else the
   * shipping arithmetic produced would still shut a door it had opened.
   *
   * The goods are the commitment that does not move. Once they are paid for,
   * how her parcels travel is a question about shipping, and she is allowed to
   * answer it.
   *
   * Nothing here decides who may SEND a box. The Ship button keeps its own
   * payment gate, so a parcel whose extra is unbilled still cannot leave — and
   * the plan is priced from scratch on every change, so whatever she
   * rearranges, reconcileParcelPlan writes the row her final plan is owed.
   */
  const owedForItems = Number(row.subtotal) - Number(row.paid)
  return owedForItems > 0 ? "unpaid" : null
}

/**
 * Tell her what her parcel is now going to do.
 *
 * The ongkir notices announce money, so a plan change costing nothing said
 * nothing at all: a customer held an order, released it and held it again, and
 * heard back about none of the three. Holding is also the change the shop most
 * often makes for her, and her only clue was a caption on a card she had to go
 * and open.
 *
 * Written here rather than in either route, because both of them come through
 * this file and a notice sent from one caller only is how half the changes go
 * unannounced.
 */
async function announcePlan(
  customerHandle: string,
  event: string,
  key: NoticeKey,
  setBy: SetBy,
  extra: Record<string, string> = {},
  db: DBExecutor = sql,
): Promise<void> {
  const template = NOTICE_TEMPLATES.find((t) => t.key === key)
  // A missing template must never take a plan change down with it: the write
  // has already happened and is the thing that mattered.
  if (!template) return
  const tokens = {
    "{event}": event,
    "{customer}": customerHandle,
    // Empty when she did it herself. Telling her what she just did is a
    // receipt; saying who did it, when it was not her, is the news.
    "{by}": setBy === "shop" ? " oleh Yubisayu" : "",
    ...extra,
  }
  try {
    await sendInvoiceNotice({
      event,
      customer: customerHandle,
      title: fillNotice(template.title, tokens),
      body: fillNotice(template.body, tokens),
    }, db)
  } catch (err) {
    console.error("Failed to announce a plan change:", err)
  }
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

/**
 * The same question for a destination, where "unpaid" does not apply to anyone.
 *
 * A mode is a commitment: hold, send early, travel with another trip. It
 * directs the shop's packing, and asking an unpaid customer not to direct it
 * is what the payment bar is for.
 *
 * An address is a fact — where the parcel goes, and therefore what it costs.
 * Gating it behind payment put the one input that decides her bill behind the
 * bill. She had to pay for the items to unlock the address, then pay again for
 * the ongkir the new address priced. The shop could always do it for her; this
 * only stops the detour through WhatsApp.
 *
 * "shipped" and "unknown" still stop everyone: a parcel that has gone has a
 * destination already, and it is not a preference any more.
 */
function blocksDestination(reason: Ineligible | null): boolean {
  return Boolean(reason) && reason !== "unpaid"
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

  // Only when it moved. Choosing the mode it already had is not news, and this
  // runs on every save whether or not anything changed.
  if ((previous?.mode ?? "wait") !== mode) {
    const key: NoticeKey =
      mode === "hold" ? "inbox_plan_hold" : mode === "split" ? "inbox_plan_split" : "inbox_plan_wait"
    await announcePlan(customer.instagram_id, event, key, setBy, {}, db)
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

  /*
   * One notice for the whole change, not one per member.
   *
   * A pairing is a single decision about two parcels, and telling her twice
   * about one box is how an inbox stops being read. It goes on the event she
   * acted on and names the others, so the row she opens is the one she was
   * looking at.
   *
   * Nothing is said when the pairing did not move: this runs on every save,
   * and re-confirming a group she already had is not news.
   */
  const before = new Set(
    prefs.filter((p) => p.mergeKey && touchedKeys.has(p.mergeKey)).map((p) => p.event),
  )
  const after = new Set(key ? wanted : [])
  const same = before.size === after.size && [...after].every((e) => before.has(e))
  if (!same) {
    if (key) {
      await announcePlan(customer.instagram_id, wanted[0], "inbox_plan_merged", setBy, {
        "{partners}": wanted.slice(1).join(" dan "),
      }, db)
    } else if (before.size) {
      // Separated. The partners it no longer travels with are the ones it had.
      const was = [...before].filter((e) => e !== wanted[0])
      await announcePlan(customer.instagram_id, wanted[0], "inbox_plan_unmerged", setBy, {
        "{partners}": was.join(" dan "),
      }, db)
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
  input: {
    address: string
    areaId?: string | null
    areaName?: string | null
    /** Who the courier should ask for. Empty keeps her own name and phone,
     *  which is what a redirect to her mother's house should not do. */
    name?: string | null
    phone?: string | null
  },
  db: DBExecutor = sql,
  /** Who recorded it. The shop writing down what she said on WhatsApp is not
   *  the customer choosing from her own page. */
  setBy: SetBy = "customer",
): Promise<void> {
  // A redirect is usually asked for early -- before the trip is settled, often
  // before anything has arrived -- so the payment bar does not apply here, to
  // the shop or to her. See blocksDestination.
  const reason = await ineligibleReason(customerId, event, db)
  if (blocksDestination(reason)) throw new ShippingPrefError(reason!)

  const value = input.address.trim() ? input.address.trim() : null
  const areaId = value && input.areaId?.trim() ? input.areaId.trim() : null
  const areaName = value && areaId && input.areaName?.trim() ? input.areaName.trim() : null
  // The recipient belongs to the redirect: clearing the address clears who it
  // was going to, or a later redirect inherits a stranger's name.
  const name = value ? String(input.name ?? "").trim().slice(0, 300) : ""
  const phone = value ? String(input.phone ?? "").trim().slice(0, 60) : ""
  await db`
    INSERT INTO customer_shipping_prefs (customer_id, event, temp_address, temp_area_id,
                                         temp_area_name, temp_name, temp_phone, set_by)
    VALUES (${customerId}, ${event}, ${value}, ${areaId}, ${areaName}, ${name}, ${phone}, ${setBy})
    ON CONFLICT (customer_id, event)
    DO UPDATE SET temp_address = ${value}, temp_area_id = ${areaId},
                  temp_area_name = ${areaName}, temp_name = ${name}, temp_phone = ${phone},
                  set_by = ${setBy}, updated_at = NOW()
  `

  // What it costs to send there, charged as an ordinary automatic adjustment.
  // Never allowed to fail the redirect: she asked for her parcel to go
  // somewhere, and a courier API having a bad minute is not an answer to that.
  try {
    await priceRedirect(customerId, event, db)
  } catch (err) {
    console.error("Failed to price a redirect:", err)
  }
}

/** Staff view: what this customer has asked for, by event. */
export async function shippingPrefsForCustomer(
  instagramId: string,
  db: DBExecutor = sql,
): Promise<ShippingPref[]> {
  const key = normalizeId(instagramId)
  const rows = await db<PrefRow[]>`
    SELECT sp.event, sp.mode, sp.set_by, sp.merge_key, sp.temp_address, sp.temp_area_id,
           sp.temp_area_name, sp.temp_name, sp.temp_phone, sp.temp_ongkir_per_kg
      FROM customer_shipping_prefs sp
      JOIN customers c ON c.id = sp.customer_id
     WHERE lower(replace(c.instagram_id, '@', '')) = ${key}
  `
  return rows.map(toPref)
}
