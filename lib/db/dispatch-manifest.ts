import sql from "../db-pool"
import type { DBExecutor } from "./actor"

/**
 * What was in the box, kept apart from who was served out of it.
 *
 * `orders.dispatch_receipt` answers the second question and moves when arrival
 * reassigns a unit to whoever paid first. The manifest answers the first and
 * never moves, which is what makes it worth having: a box that arrives short or
 * gets disputed with the courier needs what was PACKED, and the orders row
 * stopped being able to say.
 */

export interface ManifestLine {
  productId: number
  productName: string
  /**
   * The trip this line belongs to. Carried per line because a box can hold
   * more than one: MU-19953 packs goods from three, and until now the screen
   * printed the first of them over all of it.
   */
  event: string
  /** Units of this product that went into the box, ordered and surplus alike. */
  packed: number
  /** Of those, units nobody had ordered — overbuy riding along. */
  surplus: number
  /**
   * Units of it claimed by orders whose receipt reads this box today. Set when
   * the box was packed, and it moves when arrival reassigns a unit to whoever
   * paid first -- so it answers "is this box still accounted for", not "did
   * anybody get their things".
   *
   * Called `served` until 8 Sep 2026, which read as "handed over" and had the
   * owner asking why a box still at sea had served 116 units.
   */
  assigned: number
  /**
   * Units of it actually counted in against this box.
   *
   * Zero until the box is opened, which is what makes a box in transit
   * readable at a glance. Counted from the arrival history -- the only record
   * of WHEN a unit was received -- but attributed to the receipt its order
   * carries NOW, so a receipt typed wrong at the counting table and corrected
   * afterwards lands on the box it was corrected to. "Bix 4" held six of
   * CJI-04's units that way.
   */
  received: number
}

export interface BoxManifest {
  receipt: string
  event: string
  dispatchedAt: string | null
  lines: ManifestLine[]
  /**
   * Every trip this box carries, most goods first. One for almost every box;
   * MU-19953 carries three, and the header names the count rather than picking
   * one of them to display.
   */
  trips: { event: string; packed: number; received: number }[]
  packedTotal: number
  surplusTotal: number
  assignedTotal: number
  receivedTotal: number
  /**
   * What is genuinely unaccounted for: packed, minus the surplus nobody was
   * ever owed, minus what was received. Surplus is not a shortfall, and a page
   * that counted it as one would cry wolf on every box carrying overbuy.
   *
   * Measured against RECEIVED rather than assigned since 8 Sep 2026: a box in
   * transit has every unit assigned and none received, and reading that as
   * "nothing missing" is only true because nothing has been checked yet.
   */
  unaccounted: number
}

/** One row per product that went into a box in one dispatch. */
export interface ManifestEntry {
  event: string
  productId: number
  receipt: string
  qty: number
}

/**
 * Record what was dispatched, and which box it went in when that is known.
 *
 * Written in the same transaction as the order update, so the two cannot
 * disagree about a dispatch that half-happened.
 *
 * An empty receipt is KEPT rather than dropped. The shop packs first and writes
 * the tracking number across the box afterwards, or never -- 7.325 of
 * production's 9.078 dispatches have no receipt to this day. Dropping them
 * would make the manifest a record of the labelled minority, and the dispatch
 * document, which reads this table, would go blank for whole trips it used to
 * list under "—".
 *
 * So the manifest holds every dispatch; the box is simply unknown for some.
 * Reading a BOX still requires a name, because a box nobody named is not one
 * anybody can look up.
 */
export async function recordDispatchManifest(
  entries: ManifestEntry[],
  db: DBExecutor = sql,
): Promise<void> {
  const rows = entries.filter((e) => e.qty > 0)
  if (rows.length === 0) return
  await db`
    INSERT INTO dispatch_manifest (event, product_id, receipt, qty)
    SELECT * FROM unnest(
      ${rows.map((r) => r.event)}::text[],
      ${rows.map((r) => r.productId)}::int[],
      ${rows.map((r) => r.receipt.trim())}::text[],
      ${rows.map((r) => r.qty)}::int[]
    )
  `
}

/**
 * Record surplus that travelled in a box.
 *
 * Overbuy has no customer, so it lives in `excess_purchase` and moves through
 * its own dispatch step -- into the SAME physical parcel. A manifest built from
 * `orders` alone therefore describes only the part somebody ordered, and a box
 * carrying surplus reads light against what the courier weighed.
 *
 * `excess_purchase.items` is free text with no product FK, so the product is
 * found by name. That is not a new rule: it is the same match `ready-stock`
 * already uses to price surplus for the shop page. All 70 surplus lines ever
 * dispatched in production resolve this way, so nothing is lost by requiring
 * it -- and requiring it keeps the manifest one shape instead of two.
 *
 * Surplus whose text names nothing the catalogue knows is skipped rather than
 * recorded shapelessly. If that ever starts happening in volume, the honest fix
 * is to give excess_purchase a product FK, not to loosen this table.
 */
export async function recordExcessDispatchManifest(
  entry: { event: string; itemName: string; receipt: string; qty: number },
  db: DBExecutor = sql,
): Promise<{ recorded: boolean; productId: number | null }> {
  if (entry.qty <= 0 || entry.receipt.trim() === "") return { recorded: false, productId: null }

  const [match] = (await db`
    SELECT id FROM products WHERE name = ${entry.itemName} ORDER BY id LIMIT 1
  `) as unknown as { id: number }[]
  if (!match) return { recorded: false, productId: null }

  await db`
    INSERT INTO dispatch_manifest (event, product_id, receipt, qty, source)
    VALUES (${entry.event}, ${match.id}, ${entry.receipt.trim()}, ${entry.qty}, 'surplus')
  `
  return { recorded: true, productId: match.id }
}

/**
 * One box: packed, assigned, received.
 *
 * `packed` comes from the manifest and is fixed. `assigned` counts the units on
 * orders whose receipt reads this box TODAY, so it drifts when arrival moves a
 * unit to whoever paid first. `received` counts what was actually checked in.
 *
 * Received is taken from the arrival history and not from the orders, because
 * an order row records how many units have arrived but not when, and not
 * against which box each one landed. The history has both. It is attributed to
 * the receipt the order carries NOW rather than the one typed that day, so a
 * correction lands where it was corrected to -- six of CJI-04's units were
 * counted under "Bix 4" and would otherwise still be filed there, missing from
 * one box and inventing another.
 *
 * The cost of that choice, stated where the choice is made: a document
 * reprinted after a correction prints what is true now, not what was typed on
 * the day. The raw record survives in the audit log for anyone who needs it.
 *
 * Matched case-insensitively, because the code is typed by hand while packing.
 */
export async function getBoxManifest(receipt: string): Promise<BoxManifest | null> {
  const code = receipt.trim()
  if (!code) return null

  const rows = (await sql`
    WITH packed AS (
      SELECT m.event, m.product_id,
             SUM(m.qty)::int AS qty,
             SUM(m.qty) FILTER (WHERE m.source = 'surplus')::int AS surplus,
             MIN(m.dispatched_at) AS at
        FROM dispatch_manifest m
       WHERE upper(m.receipt) = upper(${code})
       GROUP BY m.event, m.product_id
    ), assigned AS (
      SELECT o.event, o.product_id, SUM(o.unit_dispatch)::int AS qty
        FROM orders o
       WHERE upper(COALESCE(o.dispatch_receipt, '')) = upper(${code})
         AND COALESCE(o.unit_dispatch, 0) > 0
       GROUP BY o.event, o.product_id
    ), received AS (
      -- Every arrival increment, tied to its order, and kept only where that
      -- order points at this box today.
      SELECT o.event, o.product_id,
             SUM( (a.new_row->>'unit_arrive')::int
                  - COALESCE((a.old_row->>'unit_arrive')::int, 0) )::int AS qty
        FROM audit.audit_log a
        JOIN orders o ON o.id = (a.new_row->>'id')::int
       WHERE a.table_name = 'orders'
         AND a.action IN ('INSERT', 'UPDATE')
         AND COALESCE((a.new_row->>'unit_arrive')::int, 0)
             > COALESCE((a.old_row->>'unit_arrive')::int, 0)
         AND upper(COALESCE(o.dispatch_receipt, '')) = upper(${code})
       GROUP BY o.event, o.product_id
    )
    SELECT COALESCE(p.event, s.event, r.event)                 AS event,
           COALESCE(p.product_id, s.product_id, r.product_id)  AS product_id,
           pr.name                                             AS product_name,
           COALESCE(p.qty, 0)                                  AS packed,
           COALESCE(p.surplus, 0)                              AS surplus,
           COALESCE(s.qty, 0)                                  AS assigned,
           COALESCE(r.qty, 0)                                  AS received,
           p.at                                                AS dispatched_at
      FROM packed p
      FULL JOIN assigned s ON s.event = p.event AND s.product_id = p.product_id
      FULL JOIN received r ON r.event = COALESCE(p.event, s.event)
                          AND r.product_id = COALESCE(p.product_id, s.product_id)
      LEFT JOIN products pr ON pr.id = COALESCE(p.product_id, s.product_id, r.product_id)
     ORDER BY pr.name
  `) as unknown as {
    event: string; product_id: number; product_name: string | null
    packed: number; surplus: number; assigned: number; received: number
    dispatched_at: string | null
  }[]

  if (rows.length === 0) return null

  const lines: ManifestLine[] = rows.map((r) => ({
    productId: r.product_id,
    productName: r.product_name ?? "(deleted product)",
    event: r.event,
    packed: r.packed,
    surplus: r.surplus,
    assigned: r.assigned,
    received: r.received,
  }))

  // One entry per trip in the box, heaviest first -- so a header can say
  // "3 trips" and a table can group by them without counting twice.
  const byTrip = new Map<string, { event: string; packed: number; received: number }>()
  for (const l of lines) {
    const t = byTrip.get(l.event) ?? { event: l.event, packed: 0, received: 0 }
    t.packed += l.packed
    t.received += l.received
    byTrip.set(l.event, t)
  }
  const trips = [...byTrip.values()].sort((a, b) => b.packed - a.packed || a.event.localeCompare(b.event))

  return {
    receipt: code,
    // The trip with most of the goods. Kept for callers that want one name;
    // anything showing this to a person should read `trips` instead, because
    // on a box carrying three this is one of three right answers.
    event: trips[0]?.event ?? rows[0].event,
    trips,
    dispatchedAt: rows.find((r) => r.dispatched_at)?.dispatched_at ?? null,
    lines,
    packedTotal: lines.reduce((n, l) => n + l.packed, 0),
    surplusTotal: lines.reduce((n, l) => n + l.surplus, 0),
    assignedTotal: lines.reduce((n, l) => n + l.assigned, 0),
    receivedTotal: lines.reduce((n, l) => n + l.received, 0),
    unaccounted: lines.reduce((n, l) => n + Math.max(0, l.packed - l.surplus - l.received), 0),
  }
}

export interface EventBox {
  receipt: string
  lines: number
  units: number
  dispatchedAt: string | null
  /** Units counted in against this box, by the same rule as getBoxManifest. */
  received: number
  /**
   * What the card says at a glance.
   *
   * "transit" is nothing counted in yet, "short" is fewer counted than packed,
   * "opened" is everything home. Computed here rather than on the screen so the
   * cards, the table and the documents cannot disagree about which box is
   * still out.
   */
  status: "transit" | "short" | "opened"
}

/**
 * Every box of a trip, newest first, for picking one to look at.
 *
 * Unnamed dispatches are excluded here: they are in the manifest so the
 * dispatch document stays whole, but they are not boxes anybody can open. What
 * they hold is offered separately as the "no box code" group.
 */
export async function getEventBoxes(event: string): Promise<EventBox[]> {
  const rows = (await sql`
    WITH packed AS (
      SELECT receipt,
             count(DISTINCT product_id)::int AS lines,
             SUM(qty)::int AS units,
             MIN(dispatched_at) AS dispatched_at
        FROM dispatch_manifest
       WHERE event = ${event}
         AND receipt <> ''
       GROUP BY receipt
    ), received AS (
      -- Arrival increments, attributed to the receipt the order carries now,
      -- so a corrected typo counts for the box it was corrected to.
      SELECT upper(COALESCE(o.dispatch_receipt, '')) AS receipt,
             SUM( (a.new_row->>'unit_arrive')::int
                  - COALESCE((a.old_row->>'unit_arrive')::int, 0) )::int AS units
        FROM audit.audit_log a
        JOIN orders o ON o.id = (a.new_row->>'id')::int
       WHERE a.table_name = 'orders'
         AND a.action IN ('INSERT', 'UPDATE')
         AND COALESCE((a.new_row->>'unit_arrive')::int, 0)
             > COALESCE((a.old_row->>'unit_arrive')::int, 0)
         AND COALESCE(o.dispatch_receipt, '') <> ''
       GROUP BY 1
    )
    SELECT p.receipt, p.lines, p.units, p.dispatched_at,
           COALESCE(r.units, 0)::int AS received
      FROM packed p
      LEFT JOIN received r ON r.receipt = upper(p.receipt)
     ORDER BY p.dispatched_at DESC NULLS LAST, p.receipt
  `) as unknown as {
    receipt: string; lines: number; units: number
    dispatched_at: string | null; received: number
  }[]
  return rows.map((r) => ({
    receipt: r.receipt,
    lines: r.lines,
    units: r.units,
    dispatchedAt: r.dispatched_at,
    received: r.received,
    status: r.received === 0 ? "transit" : r.received < r.units ? "short" : "opened",
  }))
}

/**
 * What a trip received without any box named on it.
 *
 * Every arrival counted while the receipt field was empty. It is the honest
 * group rather than a hidden one: 505 units of September's arrivals are here,
 * and they stay reachable in the list and in the documents until the habit of
 * naming a box takes hold.
 */
export async function getUncodedReceived(event: string): Promise<number> {
  const [row] = (await sql`
    SELECT COALESCE(SUM( (a.new_row->>'unit_arrive')::int
                         - COALESCE((a.old_row->>'unit_arrive')::int, 0) ), 0)::int AS units
      FROM audit.audit_log a
      JOIN orders o ON o.id = (a.new_row->>'id')::int
     WHERE a.table_name = 'orders'
       AND a.action IN ('INSERT', 'UPDATE')
       AND COALESCE((a.new_row->>'unit_arrive')::int, 0)
           > COALESCE((a.old_row->>'unit_arrive')::int, 0)
       AND o.event = ${event}
       AND COALESCE(o.dispatch_receipt, '') = ''
  `) as unknown as { units: number }[]
  return row?.units ?? 0
}
