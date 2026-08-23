import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import type { DispatchRoute } from "../dispatch-modes"

/**
 * The shipping routes and the codes that identify them.
 *
 * Owned by Settings rather than the code: the prefixes are the owner's naming,
 * and a forwarder change should not need a deploy.
 */
export async function getDispatchRoutes(db: DBExecutor = sql): Promise<DispatchRoute[]> {
  const rows = await db`
    SELECT r.key, r.label, r.warn_days, r.late_days,
           COALESCE(
             ARRAY_AGG(p.prefix ORDER BY p.position, p.prefix)
               FILTER (WHERE p.prefix IS NOT NULL),
             '{}'
           ) AS prefixes
      FROM dispatch_routes r
      LEFT JOIN dispatch_route_prefixes p ON p.route_key = r.key
     GROUP BY r.key, r.label, r.warn_days, r.late_days, r.position
     ORDER BY r.position, r.key
  `
  return rows.map((r) => ({
    key: r.key as string,
    label: r.label as string,
    prefixes: r.prefixes as string[],
    warnDays: r.warn_days as number,
    lateDays: r.late_days as number,
  }))
}

/**
 * Save the routes as edited in Settings.
 *
 * Rejects a duplicate or empty prefix before writing anything: two routes
 * sharing a prefix would make a receipt belong to both, and the receiving list
 * would file the same parcel under two tabs.
 *
 * Only the label, prefix and windows are editable — the key is what the rest
 * of the app refers to a route by, and renaming it would orphan nothing
 * visibly while quietly changing which parcels group together.
 */
export async function saveDispatchRoutes(
  routes: DispatchRoute[], db: DBExecutor = sql,
): Promise<void> {
  const seen = new Set<string>()
  const cleaned = new Map<string, string[]>()
  for (const r of routes) {
    const prefixes = r.prefixes.map((p) => p.trim().toUpperCase()).filter((p) => p !== "")
    if (prefixes.length === 0) throw new Error(`${r.label || r.key} needs at least one code`)
    for (const prefix of prefixes) {
      if (!/^[A-Z0-9]+$/.test(prefix)) {
        throw new Error(`${r.label || r.key}: a code is letters and digits only`)
      }
      if (seen.has(prefix)) throw new Error(`Two routes cannot share the code ${prefix}`)
      seen.add(prefix)
    }
    cleaned.set(r.key, [...new Set(prefixes)])
    if (!(r.warnDays > 0) || !(r.lateDays > 0)) {
      throw new Error(`${r.label || r.key}: both day counts must be positive`)
    }
    if (r.lateDays < r.warnDays) {
      throw new Error(`${r.label || r.key}: the late mark cannot come before the chase mark`)
    }
  }
  // A code must not begin with a code belonging to a DIFFERENT route, or a
  // receipt would match both and which route won would depend on the order they
  // were checked in. Two codes of the same route may overlap freely — they
  // resolve to the same tab either way.
  const owner = new Map<string, string>()
  for (const [key, prefixes] of cleaned) for (const p of prefixes) owner.set(p, key)
  for (const [a, aKey] of owner) {
    for (const [b, bKey] of owner) {
      if (a !== b && aKey !== bKey && a.startsWith(b)) {
        throw new Error(`${a} starts with ${b} — one receipt would belong to two routes`)
      }
    }
  }

  for (const r of routes) {
    const prefixes = cleaned.get(r.key)!
    await db`
      UPDATE dispatch_routes
      SET label = ${r.label.trim()},
          -- Still written: the column is NOT NULL and older code may read it
          -- until the migration that drops it lands. First code wins.
          prefix = ${prefixes[0]},
          warn_days = ${r.warnDays}, late_days = ${r.lateDays}, updated_at = NOW()
      WHERE key = ${r.key}
    `
    await db`DELETE FROM dispatch_route_prefixes WHERE route_key = ${r.key}`
    for (const [i, prefix] of prefixes.entries()) {
      await db`
        INSERT INTO dispatch_route_prefixes (prefix, route_key, position)
        VALUES (${prefix}, ${r.key}, ${i})
      `
    }
  }
}
