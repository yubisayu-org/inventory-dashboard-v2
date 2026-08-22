import postgres from "postgres"
import sql from "../db-pool"
import type { DBExecutor } from "./actor"

// Announcements the shop writes, and the per-customer read state that turns
// them into an inbox. See migration 103 for why there is no recipient table.

export type Announcement = {
  id: number
  title: string
  body: string
  createdAt: string
}

/** An announcement as one customer sees it. */
export type CustomerAnnouncement = Announcement & { read: boolean }

/** Staff view: everything, newest first. */
export async function listAnnouncements(db: DBExecutor = sql): Promise<Announcement[]> {
  const rows = await db<
    { id: number; title: string; body: string; created_at: Date }[]
  >`
    SELECT id, title, body, created_at
      FROM announcements
     ORDER BY created_at DESC, id DESC
  `
  return rows.map(toAnnouncement)
}

export async function createAnnouncement(
  data: { title: string; body: string },
  db: DBExecutor = sql,
): Promise<Announcement> {
  const [row] = await db<{ id: number; title: string; body: string; created_at: Date }[]>`
    INSERT INTO announcements (title, body)
    VALUES (${data.title.trim()}, ${data.body.trim()})
    RETURNING id, title, body, created_at
  `
  return toAnnouncement(row)
}

export async function updateAnnouncement(
  id: number,
  data: { title: string; body: string },
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE announcements
       SET title = ${data.title.trim()}, body = ${data.body.trim()}, updated_at = NOW()
     WHERE id = ${id}
  `
}

/** Deleting takes its read rows with it, via ON DELETE CASCADE. */
export async function deleteAnnouncement(id: number, db: DBExecutor = sql): Promise<void> {
  await db`DELETE FROM announcements WHERE id = ${id}`
}

/**
 * One customer's inbox, newest first.
 *
 * A missing read row means unread, so nothing is written when an announcement
 * is published — only when someone opens it. A customer who signs up tomorrow
 * therefore sees today's announcement as unread, which is right: it is new to
 * them.
 *
 * `db` must be the scoped catalogue_public connection on the public path.
 */
export async function listAnnouncementsForCustomer(
  customerId: number,
  db: postgres.Sql | DBExecutor = sql,
): Promise<CustomerAnnouncement[]> {
  const rows = await db<
    { id: number; title: string; body: string; created_at: Date; read: boolean }[]
  >`
    SELECT a.id, a.title, a.body, a.created_at,
           (r.customer_id IS NOT NULL) AS read
      FROM announcements a
      LEFT JOIN announcement_reads r
        ON r.announcement_id = a.id AND r.customer_id = ${customerId}
     ORDER BY a.created_at DESC, a.id DESC
  `
  return rows.map((r) => ({ ...toAnnouncement(r), read: r.read }))
}

/**
 * Mark every announcement read for this customer.
 *
 * Written as "insert what is missing" rather than a list of ids from the
 * client: the set the customer just saw is whatever exists now, and taking
 * ids from the request would let a caller mark rows it was never shown. ON
 * CONFLICT keeps a second open from failing.
 */
export async function markAnnouncementsRead(
  customerId: number,
  db: postgres.Sql | DBExecutor = sql,
): Promise<void> {
  await db`
    INSERT INTO announcement_reads (announcement_id, customer_id)
    SELECT a.id, ${customerId} FROM announcements a
    ON CONFLICT (announcement_id, customer_id) DO NOTHING
  `
}

function toAnnouncement(r: {
  id: number
  title: string
  body: string
  created_at: Date
}): Announcement {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    createdAt: r.created_at.toISOString(),
  }
}
