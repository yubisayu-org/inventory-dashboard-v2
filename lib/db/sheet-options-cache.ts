import sql from "../db-pool"
import { getSheetOptions } from "./orders"
import type { SheetOptions } from "./types"

/**
 * The pickers' lists, fetched once per change rather than once per page.
 *
 * getSheetOptions reads every product and every customer -- about 9,400 rows.
 * useSheetOptions runs on every dashboard page that has a picker on it, so
 * walking from Manifest to Shopping List to Expenses pulled three full
 * copies of both tables. Measured on 10 Sep 2026 it was 134M of the 349M rows
 * the database had returned since May: 38% of all egress, for four dropdowns.
 *
 * The lists themselves are small and change a few times a day. What was
 * missing was a cheap way to ask "have they changed", cheap enough to run on
 * every request -- because the reason the route refused to cache was real: a
 * product added upstairs has to appear in the picker downstairs.
 *
 * Postgres already counts writes per table, and reading those counters costs
 * 0.3ms against 423ms for counting the rows themselves. Any insert, update or
 * delete moves the number, so the cached copy is dropped within a second of a
 * real change and kept for as long as nothing happens.
 */

const WATCHED = ["products", "customers", "events", "payments"] as const

/** Writes each watched table has taken, as one short string. */
export async function optionsFingerprint(): Promise<string> {
  const rows = (await sql`
    SELECT relname, (n_tup_ins + n_tup_upd + n_tup_del)::bigint AS writes
      FROM pg_stat_user_tables
     WHERE relname = ANY(${[...WATCHED]})
     ORDER BY relname
  `) as unknown as { relname: string; writes: string }[]
  // A reset of the statistics collector moves every number at once, which
  // spends one refetch and is otherwise harmless.
  return rows.map((r) => `${r.relname}:${r.writes}`).join("|") || "none"
}

let cached: { fingerprint: string; options: SheetOptions } | null = null
/** Shared so a burst of page loads makes one query between them, not eight. */
let inFlight: Promise<SheetOptions> | null = null

/**
 * `fresh` skips the counters and reads the tables.
 *
 * For the screen that has just added a product and wants it in the picker it
 * is typing into. Postgres reports its write counters on a flush interval, so
 * for about a second after a write they still say nothing happened -- and that
 * is exactly the second in which somebody is looking for what they just added.
 */
export async function getCachedSheetOptions(
  { fresh = false }: { fresh?: boolean } = {},
): Promise<{ options: SheetOptions; fingerprint: string }> {
  const fingerprint = await optionsFingerprint()
  if (!fresh && cached && cached.fingerprint === fingerprint) {
    return { options: cached.options, fingerprint }
  }
  if (fresh) {
    const options = await getSheetOptions()
    // Stamped with the fingerprint read BEFORE the query, so a write that
    // lands while it runs still invalidates this copy rather than hiding
    // behind it.
    cached = { fingerprint, options }
    return { options, fingerprint }
  }
  if (!inFlight) {
    inFlight = getSheetOptions().finally(() => { inFlight = null })
  }
  const options = await inFlight
  cached = { fingerprint, options }
  return { options, fingerprint }
}

/** For tests, and for anything that wants the next read to go to the database. */
export function forgetSheetOptions(): void {
  cached = null
}
