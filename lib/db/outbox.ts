import sql from "@/lib/db-pool"

export interface OutboxItem {
  id: number
  postId: number
  groupJid: string
  imagePath: string
  store: string
  note: string
}

/**
 * Ask the bot to post a shelf.
 *
 * Silently does nothing when the trip has no group bound to it: uploading is
 * useful on its own — the shelf is shoppable and appears in the catalogue — and
 * refusing the upload because nobody can be told about it would be the wrong
 * trade.
 *
 * Conflicts are ignored rather than updated, so re-uploading cannot queue a
 * second send of a shelf that has already gone out.
 */
export async function queueShelfPost(postId: number, event: string): Promise<boolean> {
  const [group] = await sql`
    SELECT jid FROM wa_groups WHERE event = ${event} AND active ORDER BY created_at DESC LIMIT 1
  `
  if (!group) return false

  await sql`
    INSERT INTO wa_outbox (post_id, group_jid) VALUES (${postId}, ${group.jid})
    ON CONFLICT (post_id) DO NOTHING
  `
  return true
}

/** The next shelf waiting to be posted, oldest first. */
export async function nextPending(): Promise<OutboxItem | null> {
  const [row] = await sql`
    SELECT o.id, o.post_id, o.group_jid, p.image_path, p.store, p.note
    FROM wa_outbox o JOIN wa_posts p ON p.id = o.post_id
    WHERE o.state = 'pending'
    ORDER BY o.id ASC
    LIMIT 1
  `
  if (!row) return null
  return {
    id: row.id as number,
    postId: row.post_id as number,
    groupJid: row.group_jid as string,
    imagePath: row.image_path as string,
    store: (row.store as string) ?? "",
    note: (row.note as string) ?? "",
  }
}

/**
 * Record that a shelf went out, and which message carried it.
 *
 * The message id lands on the post as well as the outbox row, because that is
 * what makes a customer's reply resolvable: postForReply looks a quoted message
 * up against wa_posts, and until now only shelves the worker captured had one.
 */
export async function markSent(id: number, postId: number, messageId: string, groupJid: string) {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE wa_outbox SET state = 'sent', message_id = ${messageId}, sent_at = NOW()
      WHERE id = ${id}
    `
    await tx`
      UPDATE wa_posts SET message_id = ${messageId}, group_jid = ${groupJid}, updated_at = NOW()
      WHERE id = ${postId}
    `
  })
}

/** Record why a shelf did not go out. Kept, not deleted — see migration 072. */
export async function markFailed(id: number, reason: string): Promise<void> {
  await sql`
    UPDATE wa_outbox SET state = 'failed', error = ${reason.slice(0, 500)} WHERE id = ${id}
  `
}

export interface SendOutboxItem {
  id: number
  sendId: number
  groupJid: string
  mediaUrl: string
  caption: string
}

/** Ask the bot to post a composed send. Silently does nothing if the send's
 *  trip has no group bound to it, matching queueShelfPost's behaviour. */
export async function queueSend(
  sendId: number,
  event: string,
  caption: string,
): Promise<boolean> {
  const [group] = await sql`
    SELECT jid FROM wa_groups WHERE event = ${event} AND active ORDER BY created_at DESC LIMIT 1
  `
  if (!group) return false

  await sql`
    INSERT INTO wa_outbox (send_id, group_jid, caption) VALUES (${sendId}, ${group.jid}, ${caption})
    ON CONFLICT (send_id) WHERE send_id IS NOT NULL DO NOTHING
  `
  return true
}

/** The next composed send waiting to be posted, oldest first. */
export async function nextPendingSend(): Promise<SendOutboxItem | null> {
  const [row] = await sql`
    SELECT o.id, o.send_id, o.group_jid, o.caption, p.media_url
    FROM wa_outbox o
    JOIN wa_sends s ON s.id = o.send_id
    JOIN catalogue_posts p ON p.id = s.post_id
    WHERE o.state = 'pending' AND o.send_id IS NOT NULL
    ORDER BY o.id ASC
    LIMIT 1
  `
  if (!row) return null
  return {
    id: row.id as number,
    sendId: row.send_id as number,
    groupJid: row.group_jid as string,
    mediaUrl: row.media_url as string,
    caption: row.caption as string,
  }
}

/** Record that a send went out, and which message carried it. */
export async function markSendSent(id: number, sendId: number, messageId: string, groupJid: string) {
  await sql.begin(async (tx) => {
    await tx`UPDATE wa_outbox SET state = 'sent', message_id = ${messageId}, sent_at = NOW() WHERE id = ${id}`
    await tx`UPDATE wa_sends SET message_id = ${messageId}, group_jid = ${groupJid}, updated_at = NOW() WHERE id = ${sendId}`
  })
}
