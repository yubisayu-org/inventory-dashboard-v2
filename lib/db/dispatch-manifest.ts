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
  /** Units of this product that went into the box, ordered and surplus alike. */
  packed: number
  /** Of those, units nobody had ordered — overbuy riding along. */
  surplus: number
  /** Units of it the customers now holding this receipt were given. */
  served: number
}

export interface BoxManifest {
  receipt: string
  event: string
  dispatchedAt: string | null
  lines: ManifestLine[]
  packedTotal: number
  surplusTotal: number
  servedTotal: number
  /**
   * What is genuinely unaccounted for: packed, minus the surplus nobody was
   * ever owed, minus what was served. Surplus is not a shortfall, and a page
   * that counted it as one would cry wolf on every box carrying overbuy.
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
 * One box, packed against served.
 *
 * `packed` comes from the manifest and is fixed. `served` counts the units of
 * that product on orders whose receipt reads this box TODAY -- so the two
 * disagree exactly where a unit was reassigned at arrival, or where the box
 * turned up short. Which of those it was is a question for the second tab; the
 * numbers only say that it happened.
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
    ), served AS (
      SELECT o.event, o.product_id, SUM(o.unit_dispatch)::int AS qty
        FROM orders o
       WHERE upper(COALESCE(o.dispatch_receipt, '')) = upper(${code})
         AND COALESCE(o.unit_dispatch, 0) > 0
       GROUP BY o.event, o.product_id
    )
    SELECT COALESCE(p.event, s.event)           AS event,
           COALESCE(p.product_id, s.product_id) AS product_id,
           pr.name                              AS product_name,
           COALESCE(p.qty, 0)                   AS packed,
           COALESCE(p.surplus, 0)               AS surplus,
           COALESCE(s.qty, 0)                   AS served,
           p.at                                 AS dispatched_at
      FROM packed p
      FULL JOIN served s ON s.event = p.event AND s.product_id = p.product_id
      LEFT JOIN products pr ON pr.id = COALESCE(p.product_id, s.product_id)
     ORDER BY pr.name
  `) as unknown as {
    event: string; product_id: number; product_name: string | null
    packed: number; surplus: number; served: number; dispatched_at: string | null
  }[]

  if (rows.length === 0) return null

  const lines: ManifestLine[] = rows.map((r) => ({
    productId: r.product_id,
    productName: r.product_name ?? "(deleted product)",
    packed: r.packed,
    surplus: r.surplus,
    served: r.served,
  }))

  return {
    receipt: code,
    event: rows[0].event,
    dispatchedAt: rows.find((r) => r.dispatched_at)?.dispatched_at ?? null,
    lines,
    packedTotal: lines.reduce((n, l) => n + l.packed, 0),
    surplusTotal: lines.reduce((n, l) => n + l.surplus, 0),
    servedTotal: lines.reduce((n, l) => n + l.served, 0),
    unaccounted: lines.reduce((n, l) => n + l.packed - l.surplus - l.served, 0),
  }
}

/**
 * Every box of a trip, newest first, for picking one to look at.
 *
 * Unnamed dispatches are excluded: they are in the manifest so the dispatch
 * document stays whole, but they are not boxes anybody can open.
 */
export async function getEventBoxes(event: string): Promise<
  { receipt: string; lines: number; units: number; dispatchedAt: string | null }[]
> {
  const rows = (await sql`
    SELECT receipt,
           count(DISTINCT product_id)::int AS lines,
           SUM(qty)::int AS units,
           MIN(dispatched_at) AS dispatched_at
      FROM dispatch_manifest
     WHERE event = ${event}
       AND receipt <> ''
     GROUP BY receipt
     ORDER BY MIN(dispatched_at) DESC, receipt
  `) as unknown as { receipt: string; lines: number; units: number; dispatched_at: string | null }[]
  return rows.map((r) => ({
    receipt: r.receipt,
    lines: r.lines,
    units: r.units,
    dispatchedAt: r.dispatched_at,
  }))
}
