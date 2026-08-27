import sql from "../db-pool"
import { HIT_AND_RUN, NOTE_SEP } from "../hit-and-run"

export { HIT_AND_RUN } from "../hit-and-run"

export type HitAndRunRow = {
  /** Normalized handle — lowercase, no "@" — so it matches everywhere else. */
  customer: string
  /** Each distinct stamp she carries: one per trip she walked away from. */
  stamps: string[]
}

/**
 * Who has walked away from an order, and from which trips.
 *
 * There is no column for this. The record is the stamp the whole-order
 * cancellation writes onto each line's note, so finding it means reading the
 * notes -- which is cheap in the way that matters: the scan happens inside
 * Postgres and what crosses the wire is a handful of handles, not the orders.
 *
 * One query for everybody rather than one per row. A list of customers asking
 * this question one at a time would be the expensive version of the same
 * answer.
 */
export async function getHitAndRun(): Promise<HitAndRunRow[]> {
  const rows = (await sql`
    SELECT lower(replace(customer, '@', '')) AS customer,
           array_agg(DISTINCT part) AS stamps
      FROM orders,
           LATERAL unnest(string_to_array(note, ${NOTE_SEP})) AS part
     WHERE note LIKE ${'%' + HIT_AND_RUN + '%'}
       AND part LIKE ${'%' + HIT_AND_RUN + '%'}
     GROUP BY 1
     ORDER BY 1
  `) as unknown as { customer: string; stamps: string[] }[]

  return rows.map((r) => ({ customer: r.customer, stamps: r.stamps }))
}
