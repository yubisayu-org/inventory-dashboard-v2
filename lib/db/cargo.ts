import sql from "../db-pool"
import type { DBExecutor } from "./actor"

/**
 * A cargo: the delivery that brought boxes from the supplier to the warehouse.
 *
 * It owns almost nothing. Its boxes come from the arrivals that name it, its
 * dates come from when those arrivals were counted, and its cost is whatever
 * bills in operational_expenses point at it. The only thing stored on a cargo
 * is its weight, because nothing else in the system knows it.
 *
 * That is the whole design decision: one number for one fact. A cost kept here
 * as well as in the ledger would be two answers to "what did this shipment
 * cost", and the day somebody corrected one of them nothing could say which
 * was right.
 */

export interface CargoSummary {
  receipt: string
  /** Boxes whose arrivals name this cargo, newest first. */
  boxes: { receipt: string; event: string; packed: number; received: number }[]
  /** Units counted in against this cargo with no box named. */
  looseUnits: number
  /** Units counted in altogether, boxes and loose alike. */
  received: number
  /** Trips this cargo carried goods for, heaviest first. */
  events: string[]
  firstReceived: string | null
  lastReceived: string | null
  weightKg: number | null
  note: string
  /** The bills that make it up. Their sum is the cost; there is no other copy. */
  bills: {
    id: number
    date: string
    description: string
    event: string
    method: string
    amount: number
  }[]
  cost: number
}

/** Rows of the arrival history that named a cargo, attributed to today's order. */
const arrivalsWithCargo = (code: string) => sql`
  SELECT o.id                                   AS order_id,
         o.event                                AS event,
         COALESCE(o.dispatch_receipt, '')       AS box,
         (a.at AT TIME ZONE 'Asia/Jakarta')::date AS at,
         ( (a.new_row->>'unit_arrive')::int
           - COALESCE((a.old_row->>'unit_arrive')::int, 0) ) AS units
    FROM audit.audit_log a
    JOIN orders o ON o.id = (a.new_row->>'id')::int
   WHERE a.table_name = 'orders'
     AND a.action IN ('INSERT', 'UPDATE')
     AND COALESCE((a.new_row->>'unit_arrive')::int, 0)
         > COALESCE((a.old_row->>'unit_arrive')::int, 0)
     AND upper(o.cargo_receipt) = upper(${code})
`

export async function getCargo(receipt: string): Promise<CargoSummary | null> {
  const code = receipt.trim()
  if (!code) return null

  const [meta] = (await sql`
    SELECT receipt, weight_kg, COALESCE(note, '') AS note FROM cargos WHERE upper(receipt) = upper(${code})
  `) as unknown as { receipt: string; weight_kg: number | null; note: string }[]

  const arrivals = (await arrivalsWithCargo(code)) as unknown as
    { order_id: number; event: string; box: string; at: string; units: number }[]

  // A cargo nobody has counted anything against, and which nobody has weighed,
  // does not exist yet -- rather than existing as an empty shape.
  if (!arrivals.length && !meta) return null

  const boxTotals = new Map<string, { receipt: string; event: string; received: number }>()
  let looseUnits = 0
  for (const a of arrivals) {
    if (!a.box) { looseUnits += a.units; continue }
    const key = a.box.toUpperCase()
    const cur = boxTotals.get(key) ?? { receipt: a.box, event: a.event, received: 0 }
    cur.received += a.units
    boxTotals.set(key, cur)
  }

  // What those boxes were packed with, which the manifest owns.
  const packedRows = boxTotals.size
    ? (await sql`
        SELECT upper(receipt) AS box, SUM(qty)::int AS packed
          FROM dispatch_manifest
         WHERE upper(receipt) = ANY(${[...boxTotals.keys()]})
         GROUP BY 1
      `) as unknown as { box: string; packed: number }[]
    : []
  const packed = new Map(packedRows.map((r) => [r.box, r.packed]))

  const boxes = [...boxTotals.entries()]
    .map(([key, b]) => ({ ...b, packed: packed.get(key) ?? 0 }))
    .sort((a, b) => b.received - a.received || a.receipt.localeCompare(b.receipt))

  const days = arrivals.map((a) => a.at).sort()
  const byEvent = new Map<string, number>()
  for (const a of arrivals) byEvent.set(a.event, (byEvent.get(a.event) ?? 0) + a.units)

  const bills = (await sql`
    SELECT id, expense_date::text AS date, COALESCE(description, '') AS description,
           COALESCE(event, '') AS event, COALESCE(method, '') AS method, amount_idr::int AS amount
      FROM operational_expenses
     WHERE upper(COALESCE(cargo_receipt, '')) = upper(${code})
     ORDER BY expense_date, id
  `) as unknown as CargoSummary["bills"]

  return {
    receipt: meta?.receipt ?? code,
    boxes,
    looseUnits,
    received: arrivals.reduce((n, a) => n + a.units, 0),
    events: [...byEvent.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e),
    firstReceived: days[0] ?? null,
    lastReceived: days[days.length - 1] ?? null,
    weightKg: meta?.weight_kg ?? null,
    note: meta?.note ?? "",
    bills,
    cost: bills.reduce((n, b) => n + b.amount, 0),
  }
}

/**
 * Every cargo a trip's arrivals name, for the strip and the search field.
 *
 * Counted from the trip's own arrivals, so a cargo that also carried another
 * trip's boxes appears on both — which is true of the goods, and is why the
 * cargo itself is not scoped to a trip.
 */
export async function getEventCargos(event: string): Promise<
  { receipt: string; boxes: number; received: number; looseUnits: number; cost: number }[]
> {
  const rows = (await sql`
    WITH arrivals AS (
      SELECT upper(o.cargo_receipt)              AS cargo,
             COALESCE(o.dispatch_receipt, '')    AS box,
             ( (a.new_row->>'unit_arrive')::int
               - COALESCE((a.old_row->>'unit_arrive')::int, 0) ) AS units
        FROM audit.audit_log a
        JOIN orders o ON o.id = (a.new_row->>'id')::int
       WHERE a.table_name = 'orders'
         AND a.action IN ('INSERT', 'UPDATE')
         AND COALESCE((a.new_row->>'unit_arrive')::int, 0)
             > COALESCE((a.old_row->>'unit_arrive')::int, 0)
         AND o.event = ${event}
         AND COALESCE(o.cargo_receipt, '') <> ''
    ), grouped AS (
      SELECT cargo,
             COUNT(DISTINCT NULLIF(box, ''))::int AS boxes,
             SUM(units)::int                      AS received,
             SUM(units) FILTER (WHERE box = '')::int AS loose
        FROM arrivals GROUP BY cargo
    )
    SELECT g.cargo AS receipt, g.boxes, g.received, COALESCE(g.loose, 0)::int AS loose,
           COALESCE((SELECT SUM(e.amount_idr)::int FROM operational_expenses e
                      WHERE upper(COALESCE(e.cargo_receipt, '')) = g.cargo), 0) AS cost
      FROM grouped g
     ORDER BY g.received DESC, g.cargo
  `) as unknown as { receipt: string; boxes: number; received: number; loose: number; cost: number }[]
  return rows.map((r) => ({
    receipt: r.receipt, boxes: r.boxes, received: r.received, looseUnits: r.loose, cost: r.cost,
  }))
}

/**
 * Units counted in on a trip with no box code, split by the cargo they name.
 *
 * One entry per cargo, and one for the pile with neither — which is the last
 * card in the strip, being the least identifiable thing on the trip.
 */
export async function getUncodedByCargo(event: string): Promise<{ cargo: string | null; units: number }[]> {
  const rows = (await sql`
    SELECT NULLIF(upper(o.cargo_receipt), '') AS cargo,
           SUM( (a.new_row->>'unit_arrive')::int
                - COALESCE((a.old_row->>'unit_arrive')::int, 0) )::int AS units
      FROM audit.audit_log a
      JOIN orders o ON o.id = (a.new_row->>'id')::int
     WHERE a.table_name = 'orders'
       AND a.action IN ('INSERT', 'UPDATE')
       AND COALESCE((a.new_row->>'unit_arrive')::int, 0)
           > COALESCE((a.old_row->>'unit_arrive')::int, 0)
       AND o.event = ${event}
       AND COALESCE(o.dispatch_receipt, '') = ''
     GROUP BY 1
  `) as unknown as { cargo: string | null; units: number }[]
  // Cargo first, the nameless pile last.
  return rows.sort((a, b) => (a.cargo ? 0 : 1) - (b.cargo ? 0 : 1)
    || String(a.cargo).localeCompare(String(b.cargo)))
}

/** The cargo a box belongs to, from the arrivals that filled it. */
export async function getBoxCargo(box: string): Promise<string | null> {
  const [row] = (await sql`
    SELECT NULLIF(upper(o.cargo_receipt), '') AS cargo
      FROM orders o
     WHERE upper(COALESCE(o.dispatch_receipt, '')) = upper(${box.trim()})
       AND COALESCE(o.cargo_receipt, '') <> ''
     LIMIT 1
  `) as unknown as { cargo: string | null }[]
  return row?.cargo ?? null
}

/** Weight is the one figure a cargo keeps, so this is the only writer of it. */
export async function setCargoWeight(
  receipt: string,
  weightKg: number | null,
  note = "",
  db: DBExecutor = sql,
): Promise<void> {
  const code = receipt.trim()
  if (!code) throw new Error("A cargo needs a receipt")
  await db`
    INSERT INTO cargos (receipt, weight_kg, note)
    VALUES (${code}, ${weightKg}, ${note})
    ON CONFLICT (receipt) DO UPDATE
      SET weight_kg = ${weightKg}, note = ${note}, updated_at = NOW()
  `
}

/**
 * Attach an expense already in the ledger to a cargo, or let it go.
 *
 * Nothing about the money moves: the row keeps its amount, its date and its
 * account. All that changes is that the cargo can now find it.
 */
export async function setExpenseCargo(
  expenseId: number,
  receipt: string | null,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE operational_expenses
       SET cargo_receipt = ${receipt?.trim() || null}, updated_at = NOW()
     WHERE id = ${expenseId}
  `
}

/** Cargo bills with no cargo named yet — what the "link an existing bill" list offers. */
export async function getUnlinkedCargoBills(event?: string | null): Promise<CargoSummary["bills"]> {
  return (await sql`
    SELECT id, expense_date::text AS date, COALESCE(description, '') AS description,
           COALESCE(event, '') AS event, COALESCE(method, '') AS method, amount_idr::int AS amount
      FROM operational_expenses
     WHERE cargo_receipt IS NULL
       AND category = 'Cargo'
       ${event ? sql`AND event = ${event}` : sql``}
     ORDER BY expense_date DESC, id DESC
     LIMIT 50
  `) as unknown as CargoSummary["bills"]
}
