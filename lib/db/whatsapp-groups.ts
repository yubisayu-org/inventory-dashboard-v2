import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { tsToString } from "./helpers"

export interface WaGroup {
  jid: string
  name: string
  event: string | null
  active: boolean
  createdAt: string
}

export interface BotAdmin {
  number: string
  label: string
  canConnect: boolean
}

export interface Capture {
  id: number
  groupJid: string
  store: string
  openedAt: string
}

/**
 * Strip a WhatsApp number down to digits.
 *
 * Numbers arrive as JIDs, with plus signs, with leading zeros, and typed by hand
 * into a settings form. Comparing any two of those spellings directly fails, and
 * a failed comparison here means a command silently ignored.
 */
export function normalizeNumber(value: string): string {
  const digits = value.replace(/\D/g, "")
  // Indonesian numbers are written 08xx locally and 628xx internationally.
  return digits.startsWith("0") ? `62${digits.slice(1)}` : digits
}

/** Record a group, or refresh its cached name. Never touches its event. */
export async function upsertGroup(
  input: { jid: string; name: string },
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    INSERT INTO wa_groups (jid, name, name_checked_at)
    VALUES (${input.jid}, ${input.name}, NOW())
    ON CONFLICT (jid) DO UPDATE SET
      name = EXCLUDED.name,
      name_checked_at = NOW(),
      updated_at = NOW()
  `
}

/** Bind a group to the trip whose claims it collects. */
export async function bindGroupToEvent(
  jid: string,
  event: string | null,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE wa_groups SET event = ${event}, updated_at = NOW() WHERE jid = ${jid}
  `
}

export async function listGroups(): Promise<WaGroup[]> {
  const rows = await sql`SELECT * FROM wa_groups ORDER BY name ASC, jid ASC`
  return rows.map((r) => ({
    jid: r.jid as string,
    name: (r.name as string) ?? "",
    event: (r.event as string | null) ?? null,
    active: (r.active as boolean) ?? true,
    createdAt: tsToString(r.created_at as Date | null),
  }))
}

export async function addBotAdmin(
  input: { number: string; label: string; canConnect: boolean },
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    INSERT INTO wa_admins (number, label, can_connect)
    VALUES (${normalizeNumber(input.number)}, ${input.label}, ${input.canConnect})
    ON CONFLICT (number) DO UPDATE SET
      label = EXCLUDED.label,
      can_connect = EXCLUDED.can_connect
  `
}

export async function removeBotAdmin(number: string, db: DBExecutor = sql): Promise<void> {
  await db`DELETE FROM wa_admins WHERE number = ${normalizeNumber(number)}`
}

export async function listBotAdmins(): Promise<BotAdmin[]> {
  const rows = await sql`SELECT * FROM wa_admins ORDER BY number ASC`
  return rows.map((r) => ({
    number: r.number as string,
    label: (r.label as string) ?? "",
    canConnect: (r.can_connect as boolean) ?? false,
  }))
}

export async function isBotAdmin(number: string): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM wa_admins WHERE number = ${normalizeNumber(number)}`
  return Boolean(row)
}

export async function canConnect(number: string): Promise<boolean> {
  const [row] = await sql`
    SELECT 1 FROM wa_admins WHERE number = ${normalizeNumber(number)} AND can_connect
  `
  return Boolean(row)
}

/**
 * Start collecting, or move the open window to a new shop.
 *
 * Re-opening while a window is open is not an error: it is the owner walking
 * into the next store and saying so. Treating it as one would leave photos from
 * the second shop filed under the first.
 */
export async function openCapture(
  jid: string,
  store: string,
  db: DBExecutor = sql,
): Promise<void> {
  const [open] = await db`
    SELECT id FROM wa_captures WHERE group_jid = ${jid} AND closed_at IS NULL
  `
  if (open) {
    await db`UPDATE wa_captures SET store = ${store.trim()} WHERE id = ${open.id}`
    return
  }
  await db`
    INSERT INTO wa_captures (group_jid, store) VALUES (${jid}, ${store.trim()})
  `
}

export async function closeCapture(jid: string, db: DBExecutor = sql): Promise<void> {
  await db`
    UPDATE wa_captures SET closed_at = NOW()
    WHERE group_jid = ${jid} AND closed_at IS NULL
  `
}

/** The open window for a group, or null when it is not collecting. */
export async function currentCapture(jid: string): Promise<Capture | null> {
  const [row] = await sql`
    SELECT * FROM wa_captures WHERE group_jid = ${jid} AND closed_at IS NULL
  `
  if (!row) return null
  return {
    id: row.id as number,
    groupJid: row.group_jid as string,
    store: (row.store as string) ?? "",
    openedAt: tsToString(row.opened_at as Date | null),
  }
}
