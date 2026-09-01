/**
 * Rebuild the dispatch manifest from what the audit log already knows.
 *
 *   npx tsx --env-file=.env.development.local scripts/backfill-dispatch-manifest.ts
 *   npx tsx --env-file=.env.local            scripts/backfill-dispatch-manifest.ts --write
 *
 * Every dispatch left an audit entry carrying its own quantity, so the
 * QUANTITIES are a reconstruction rather than a guess. The BOXES are the hard
 * part, and two things about how the shop actually works decide the algorithm:
 *
 * 1. The receipt is usually not typed at dispatch. 7.319 of production's 9.073
 *    dispatch events recorded no receipt at all -- the goods are packed first
 *    and the tracking number is written across the whole box afterwards. A
 *    backfill that only reads the receipt present at dispatch time recovers a
 *    fifth of the shipment and silently drops the rest.
 *
 * 2. Boxes get renamed. The label typed while packing is a working name --
 *    "Box 7", "Inaba", "CJI-SHINTAMP-REG/1" -- replaced later by the tracking
 *    number the courier issued.
 *
 * Both are bulk writes across a whole box, and that is exactly what separates
 * them from an ARRIVAL REASSIGNMENT, which moves one person's units to whichever
 * box served her. A reassignment must NOT move the manifest -- it is the very
 * thing the manifest exists to stop -- so:
 *
 *     receipt written across >= 2 lines in one transaction  ->  the box
 *     receipt moved on a single line                        ->  who was served
 *
 * So the log is replayed per order line, in time order. A dispatch emits a
 * manifest entry; a bulk receipt write stamps the box onto that line's entries
 * that are still waiting for one; a single-line move is ignored.
 *
 * Re-runnable: it truncates and rebuilds. The table is derived, so losing it
 * costs nothing while the audit log survives.
 */

import sql from "../lib/db-pool"

const WRITE = process.argv.includes("--write")

/** Below this, a receipt-only transaction is one person's units moving. */
const BULK_MIN_LINES = 2

type Entry = { orderId: number; event: string; productId: number; qty: number; at: string; receipt: string }

type Row = {
  order_id: number
  event: string
  product_id: number
  at: string
  txid: string
  old_dispatch: number
  new_dispatch: number
  old_receipt: string
  new_receipt: string
}

async function main() {
  console.log(WRITE ? "Writing.\n" : "Dry run — pass --write to apply.\n")

  // Everything that ever touched a dispatch: the quantity moving, the receipt
  // moving, or both. Ordered, because this is a replay.
  const rows = (await sql`
    SELECT
      (a.new_row->>'id')::int          AS order_id,
      (a.new_row->>'event')            AS event,
      (a.new_row->>'product_id')::int  AS product_id,
      a.at,
      a.txid::text                     AS txid,
      COALESCE((a.old_row->>'unit_dispatch')::int, 0) AS old_dispatch,
      COALESCE((a.new_row->>'unit_dispatch')::int, 0) AS new_dispatch,
      COALESCE(a.old_row->>'dispatch_receipt', '')    AS old_receipt,
      COALESCE(a.new_row->>'dispatch_receipt', '')    AS new_receipt
    FROM audit.audit_log a
    WHERE a.table_name = 'orders'
      AND a.action IN ('INSERT', 'UPDATE')
      AND (
        COALESCE((a.new_row->>'unit_dispatch')::int, 0)
          > COALESCE((a.old_row->>'unit_dispatch')::int, 0)
        OR COALESCE(a.old_row->>'dispatch_receipt', '')
          <> COALESCE(a.new_row->>'dispatch_receipt', '')
      )
    ORDER BY a.at, a.id
  `) as unknown as Row[]

  // postgres.js hands timestamps back as Date objects; the replay compares them
  // and the insert casts them, and both want one stable representation.
  for (const r of rows) r.at = new Date(r.at).toISOString()

  // How many lines each transaction touched the receipt of. A whole box moving
  // at once is the shop naming or renaming it; one line is a customer being
  // served from somewhere else.
  const txLines = new Map<string, number>()
  for (const r of rows) {
    if (r.old_receipt !== r.new_receipt) {
      txLines.set(r.txid, (txLines.get(r.txid) ?? 0) + 1)
    }
  }

  const entries: Entry[] = []
  /** Manifest entries per order line that are still waiting for a box. */
  const openByOrder = new Map<number, Entry[]>()
  let dispatchEvents = 0
  let stamped = 0
  let renamed = 0
  let ignoredReassignments = 0

  for (const r of rows) {
    const gained = r.new_dispatch - r.old_dispatch
    const receiptChanged = r.old_receipt !== r.new_receipt
    const isBulk = receiptChanged && (txLines.get(r.txid) ?? 0) >= BULK_MIN_LINES

    if (gained > 0) {
      dispatchEvents++
      // Whatever the row says right now. Usually empty — the box is named later.
      const at_dispatch = newlyAdded(r.old_receipt, r.new_receipt)
      const entry: Entry = {
        orderId: r.order_id,
        event: r.event,
        productId: r.product_id,
        qty: gained,
        at: r.at,
        receipt: at_dispatch,
      }
      entries.push(entry)
      if (!at_dispatch) {
        const open = openByOrder.get(r.order_id) ?? []
        open.push(entry)
        openByOrder.set(r.order_id, open)
      }
    }

    if (!receiptChanged) continue

    if (!isBulk) {
      // One line moving on its own: a unit served out of a different box. The
      // manifest is the record of what was packed and must not follow it.
      ignoredReassignments++
      continue
    }

    if (r.old_receipt === "") {
      // The box being named for the first time, across everything in it.
      const open = openByOrder.get(r.order_id)
      if (open && open.length > 0) {
        for (const e of open) { e.receipt = r.new_receipt.trim(); stamped++ }
        openByOrder.delete(r.order_id)
      }
    } else {
      // A relabel: everything this line already carries under the old name.
      for (const e of entries) {
        if (e.orderId === r.order_id && e.receipt === r.old_receipt.trim() && e.at <= r.at) {
          e.receipt = r.new_receipt.trim()
          renamed++
        }
      }
    }
  }

  // A product deleted since it shipped cannot be referenced, and a manifest
  // line naming nothing is not worth keeping. Dev carries these from test rows;
  // production should carry none.
  const live = (await sql`SELECT id FROM products`) as unknown as { id: number }[]
  const liveEvents = (await sql`SELECT name FROM events`) as unknown as { name: string }[]
  const liveIds = new Set(live.map((p) => p.id))
  const liveEventNames = new Set(liveEvents.map((e) => e.name))
  // Unnamed dispatches are kept: they are most of the shop's history, and the
  // dispatch document reads this table. Dropping them would blank whole trips.
  const keeps = (e: Entry) => liveIds.has(e.productId) && liveEventNames.has(e.event)
  const orphaned = entries.filter((e) => !keeps(e))
  if (orphaned.length > 0) {
    console.log(`\n${orphaned.length} rows skipped — their product or trip has since been deleted`)
  }

  const kept = entries.filter(keeps)
  const placed = kept.filter((e) => e.receipt !== "")
  const unplaced = kept.filter((e) => e.receipt === "")
  const units = (list: Entry[]) => list.reduce((n, e) => n + e.qty, 0)

  console.log(`${dispatchEvents} dispatch events, ${units(entries)} units`)
  console.log(`  ${stamped} entries stamped when their box was first named`)
  console.log(`  ${renamed} entries followed through a rename`)
  console.log(`  ${ignoredReassignments} single-line receipt moves ignored (arrival reassignments)`)

  const boxes = new Set(placed.map((e) => e.receipt))
  console.log(`\nplaced:   ${placed.length} rows · ${units(placed)} units · ${boxes.size} boxes`)
  console.log(`unnamed:  ${unplaced.length} rows · ${units(unplaced)} units — recorded, but no box was ever named`)

  if (unplaced.length > 0) {
    const byEvent = new Map<string, number>()
    for (const e of unplaced) byEvent.set(e.event, (byEvent.get(e.event) ?? 0) + e.qty)
    console.log("  by trip:", [...byEvent].sort((a, b) => b[1] - a[1])
      .slice(0, 6).map(([ev, n]) => `${ev}:${n}`).join("  "))
  }

  if (!WRITE) {
    console.log("\nNothing written.")
    await sql.end()
    return
  }

  await sql.begin(async (tx) => {
    await tx`TRUNCATE dispatch_manifest`
    const CHUNK = 500
    for (let i = 0; i < kept.length; i += CHUNK) {
      const c = kept.slice(i, i + CHUNK)
      await tx`
        INSERT INTO dispatch_manifest (event, product_id, receipt, qty, dispatched_at)
        SELECT * FROM unnest(
          ${c.map((e) => e.event)}::text[],
          ${c.map((e) => e.productId)}::int[],
          ${c.map((e) => e.receipt)}::text[],
          ${c.map((e) => e.qty)}::int[],
          ${c.map((e) => e.at)}::timestamptz[]
        )
      `
    }
  })

  const [n] = (await sql`SELECT count(*)::int AS n FROM dispatch_manifest`) as unknown as { n: number }[]
  console.log(`\nWritten. dispatch_manifest holds ${n.n} rows.`)
  await sql.end()
}

/**
 * The part of the receipt this write added.
 *
 * The column accumulates comma-joined batches, so a line dispatched twice into
 * two boxes reads "CJI-01, CJI-05" and only the tail belongs to this dispatch.
 */
function newlyAdded(oldReceipt: string, newReceipt: string): string {
  if (!newReceipt) return ""
  if (!oldReceipt) return newReceipt.trim()
  if (newReceipt === oldReceipt) return ""
  if (newReceipt.startsWith(oldReceipt)) {
    return newReceipt.slice(oldReceipt.length).replace(/^\s*,\s*/, "").trim()
  }
  // Not an append — the whole thing was replaced. That is a rename, handled by
  // the caller, so this dispatch has no box of its own yet.
  return ""
}

main()
