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
    SELECT key, label, prefix, warn_days, late_days
    FROM dispatch_routes ORDER BY position, key
  `
  return rows.map((r) => ({
    key: r.key as string,
    label: r.label as string,
    prefix: r.prefix as string,
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
  for (const r of routes) {
    const prefix = r.prefix.trim().toUpperCase()
    if (!prefix) throw new Error(`${r.label || r.key} needs a code`)
    if (!/^[A-Z0-9]+$/.test(prefix)) {
      throw new Error(`${r.label || r.key}: a code is letters and digits only`)
    }
    if (seen.has(prefix)) throw new Error(`Two routes cannot share the code ${prefix}`)
    seen.add(prefix)
    if (!(r.warnDays > 0) || !(r.lateDays > 0)) {
      throw new Error(`${r.label || r.key}: both day counts must be positive`)
    }
    if (r.lateDays < r.warnDays) {
      throw new Error(`${r.label || r.key}: the late mark cannot come before the chase mark`)
    }
  }
  // One prefix must not be the start of another, or a receipt would match both
  // and which route won would depend on the order they were checked in.
  const prefixes = [...seen]
  for (const a of prefixes) {
    for (const b of prefixes) {
      if (a !== b && a.startsWith(b)) {
        throw new Error(`${a} starts with ${b} — one receipt would belong to both routes`)
      }
    }
  }

  for (const r of routes) {
    await db`
      UPDATE dispatch_routes
      SET label = ${r.label.trim()}, prefix = ${r.prefix.trim().toUpperCase()},
          warn_days = ${r.warnDays}, late_days = ${r.lateDays}, updated_at = NOW()
      WHERE key = ${r.key}
    `
  }
}
