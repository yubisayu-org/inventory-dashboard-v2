import sql from "@/lib/db-pool"
import type { DBExecutor } from "./actor"
import { nextCode } from "@/lib/whatsapp/codes"

export interface WaSend {
  id: number
  postId: number
  event: string
  title: string
  messageId: string
  groupJid: string
  createdAt: string
}

export interface WaSendCode {
  id: number
  sendId: number
  productId: number
  productName: string
  code: string
  event: string
  price: number
  pointX: number | null
  pointY: number | null
  position: number
}

function toSend(row: Record<string, unknown>): WaSend {
  return {
    id: row.id as number,
    postId: row.post_id as number,
    event: row.event as string,
    title: row.title as string,
    messageId: row.message_id as string,
    groupJid: row.group_jid as string,
    createdAt: (row.created_at as Date).toISOString(),
  }
}

function toSendCode(row: Record<string, unknown>): WaSendCode {
  return {
    id: row.id as number,
    sendId: row.send_id as number,
    productId: row.product_id as number,
    productName: row.product_name as string,
    code: row.code as string,
    event: row.event as string,
    price: Number(row.price),
    pointX: row.point_x === null ? null : Number(row.point_x),
    pointY: row.point_y === null ? null : Number(row.point_y),
    position: row.position as number,
  }
}

export async function createSend(
  input: { postId: number; event: string; title: string },
  db: DBExecutor = sql,
): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO wa_sends (post_id, event, title)
    VALUES (${input.postId}, ${input.event}, ${input.title})
    RETURNING id
  `
  return { id: row.id as number }
}

export async function getSend(id: number, db: DBExecutor = sql): Promise<WaSend | null> {
  const [row] = await db`SELECT * FROM wa_sends WHERE id = ${id}`
  return row ? toSend(row) : null
}

export async function listSendCodes(sendId: number, db: DBExecutor = sql): Promise<WaSendCode[]> {
  const rows = await db`
    SELECT c.*, p.name AS product_name
    FROM wa_send_codes c JOIN products p ON p.id = c.product_id
    WHERE c.send_id = ${sendId}
    ORDER BY c.position, c.id
  `
  return rows.map(toSendCode)
}

/**
 * Tag a product onto the send's underlying post (if not already tagged) and
 * issue it the next free code for the send's event, snapshotting the
 * product's current price.
 */
export async function attachProductToSend(
  sendId: number,
  productId: number,
  // Kept only for interface parity with the rest of this file's exports —
  // it can't actually be used to run this inside a caller's transaction.
  // `DBExecutor` (`postgres.ISql`) doesn't expose `.begin` (only the pool
  // type, `postgres.Sql`, does), which is why every other multi-statement
  // write in lib/db/* always opens its own transaction via the imported
  // `sql` rather than an injected executor (e.g. lib/db/finance.ts's
  // executeRefund, lib/db/outbox.ts's markSent).
  _db: DBExecutor = sql,
): Promise<WaSendCode> {
  return sql.begin(async (tx) => {
    const [send] = await tx`SELECT post_id, event FROM wa_sends WHERE id = ${sendId}`
    if (!send) throw new Error("send not found")

    await tx`
      INSERT INTO catalogue_post_products (post_id, product_id)
      VALUES (${send.post_id}, ${productId})
      ON CONFLICT DO NOTHING
    `

    const [product] = await tx`SELECT name, price FROM products WHERE id = ${productId}`
    if (!product) throw new Error("product not found")

    const [position] = await tx`SELECT count(*)::int AS n FROM wa_send_codes WHERE send_id = ${sendId}`

    // A code already issued to this product BY THIS SAME POST, anywhere in
    // this event, is moved onto the new send rather than left behind and
    // duplicated — "Kirim ulang" re-tagging the exact same product would
    // otherwise mint a brand new code every time, even though nothing
    // changed (confusing to the owner) or, worse, try to INSERT a second row
    // with the same (event, code) pair and hit the unique index
    // (idx_wa_send_codes_code) head-on. Scoped to this post specifically —
    // not just this product in this event — so two different posts that
    // happen to tag the same product don't steal each other's code; each
    // still gets (and keeps) its own.
    const [reuse] = await tx`
      SELECT c.id FROM wa_send_codes c
      JOIN wa_sends s2 ON s2.id = c.send_id
      WHERE c.event = ${send.event} AND c.product_id = ${productId} AND s2.post_id = ${send.post_id}
      ORDER BY c.id DESC LIMIT 1
    `
    if (reuse) {
      const [moved] = await tx`
        UPDATE wa_send_codes
        SET send_id = ${sendId}, price = ${product.price}, position = ${position.n}
        WHERE id = ${reuse.id}
        RETURNING *
      `
      return toSendCode({ ...moved, product_name: product.name })
    }

    const existing = await tx`SELECT code FROM wa_send_codes WHERE event = ${send.event}`
    const code = nextCode(existing.map((r) => r.code as string))

    // ON CONFLICT (send_id, product_id) DO NOTHING + the unique index from
    // migration 084 is what actually closes the double-attach race
    // (finding 6 of the final whole-branch review), regardless of what the
    // client does: two concurrent calls for the SAME product on the SAME
    // send can both read `existing` before either commits and compute the
    // same next code, but only one INSERT can win the (send_id, product_id)
    // slot — the loser's RETURNING comes back empty here, and it falls
    // through to returning the WINNER's already-committed row instead of
    // erroring or minting a second code for the same product.
    const [inserted] = await tx`
      INSERT INTO wa_send_codes (send_id, product_id, code, event, price, position)
      VALUES (${sendId}, ${productId}, ${code}, ${send.event}, ${product.price}, ${position.n})
      ON CONFLICT (send_id, product_id) DO NOTHING
      RETURNING *
    `
    if (inserted) return toSendCode({ ...inserted, product_name: product.name })

    const [existingRow] = await tx`
      SELECT * FROM wa_send_codes WHERE send_id = ${sendId} AND product_id = ${productId}
    `
    return toSendCode({ ...existingRow, product_name: product.name })
  })
}

/**
 * Untag a product from a draft send — the counterpart attachProductToSend
 * never got (its own docblock deferred this as YAGNI; editing an existing
 * post's tags is the case that actually needed it). Only removes the
 * post-level tag (catalogue_post_products) too when no OTHER send of the
 * same post still carries that product — a code retired from one draft
 * shouldn't erase a tag a past, already-sent post still legitimately has.
 */
export async function removeProductFromSend(
  sendId: number,
  codeId: number,
): Promise<void> {
  await sql.begin(async (tx) => {
    const [code] = await tx`
      SELECT c.product_id, s.post_id
      FROM wa_send_codes c JOIN wa_sends s ON s.id = c.send_id
      WHERE c.id = ${codeId} AND c.send_id = ${sendId}
    `
    if (!code) throw new Error("code not found")

    await tx`DELETE FROM wa_send_codes WHERE id = ${codeId}`

    const [stillTagged] = await tx`
      SELECT 1 FROM wa_send_codes c
      JOIN wa_sends s ON s.id = c.send_id
      WHERE s.post_id = ${code.post_id} AND c.product_id = ${code.product_id}
    `
    if (!stillTagged) {
      await tx`
        DELETE FROM catalogue_post_products
        WHERE post_id = ${code.post_id} AND product_id = ${code.product_id}
      `
    }
  })
}

/**
 * Resolve a claimed code — but ONLY if the send it belongs to has actually
 * gone out (has a message_id). Without this join, a code allocated on a
 * never-sent draft (a real, everyday state now that "Simpan draf" is a
 * first-class composer action — see the final whole-branch review's finding
 * 2) would still resolve a customer's message into a claim against a post
 * she was never shown; codes are allocated from the trip's SHARED sequence
 * (attachProductToSend scans every send of the event, draft or not), so a
 * draft's code is a real, live-looking code, not an obviously-fake one.
 * Mirrors the exact `s.message_id <> ''` convention getOpenSendForGroup and
 * listOpenSendsForEvent already established.
 */
export async function getSendCodeByCode(
  event: string,
  code: string,
  db: DBExecutor = sql,
): Promise<WaSendCode | null> {
  const [row] = await db`
    SELECT c.*, p.name AS product_name
    FROM wa_send_codes c
    JOIN products p ON p.id = c.product_id
    JOIN wa_sends s ON s.id = c.send_id
    WHERE c.event = ${event} AND c.code = ${code} AND s.message_id <> ''
  `
  return row ? toSendCode(row) : null
}

/**
 * Each product's most recently placed pin on this post, across every send
 * that ever carried it — keyed by product id.
 *
 * `DISTINCT ON (product_id) ... ORDER BY product_id, id DESC` picks the
 * newest `wa_send_codes` row per product, so a repost-of-a-repost still
 * carries forward whatever pin was placed most recently, not just the
 * original. Rows with no pin placed yet are excluded rather than returned
 * as null — the composer's prefill only ever needs positions it can use.
 */
export async function getLastPinPositions(
  postId: number,
  db: DBExecutor = sql,
): Promise<Record<number, { x: number; y: number }>> {
  const rows = await db`
    SELECT DISTINCT ON (c.product_id) c.product_id, c.point_x, c.point_y
    FROM wa_send_codes c
    JOIN wa_sends s ON s.id = c.send_id
    WHERE s.post_id = ${postId} AND c.point_x IS NOT NULL AND c.point_y IS NOT NULL
    ORDER BY c.product_id, c.id DESC
  `
  const result: Record<number, { x: number; y: number }> = {}
  for (const row of rows) {
    result[row.product_id as number] = { x: Number(row.point_x), y: Number(row.point_y) }
  }
  return result
}

/**
 * The send bound to this group's currently-active trip, if it has actually
 * gone out (has a message_id). Mirrors the "unquoted → group's bound event"
 * half of the existing shelf resolution pattern in worker/capture.ts.
 */
export async function getOpenSendForGroup(groupJid: string, db: DBExecutor = sql): Promise<WaSend | null> {
  const [row] = await db`
    SELECT s.* FROM wa_sends s
    JOIN wa_groups g ON g.event = s.event
    WHERE g.jid = ${groupJid} AND s.message_id <> ''
    ORDER BY s.id DESC
    LIMIT 1
  `
  return row ? toSend(row) : null
}

/**
 * Every send for this event that has actually gone out (has a message_id),
 * newest first.
 *
 * A trip can have more than one live post — a restock, a second rack of the
 * same shop — so a claim's name/token matching must be scoped to ALL of
 * them, not just the group's single newest one (getOpenSendForGroup). That
 * function still exists and is unchanged: it answers "which send does an
 * unquoted message resolve to / is the trip still open", a different
 * question from "which products can a store-code-free message match".
 */
export async function listOpenSendsForEvent(event: string, db: DBExecutor = sql): Promise<WaSend[]> {
  const rows = await db`
    SELECT * FROM wa_sends WHERE event = ${event} AND message_id <> '' ORDER BY id DESC
  `
  return rows.map(toSend)
}

export async function getSendByMessage(
  groupJid: string,
  messageId: string,
  db: DBExecutor = sql,
): Promise<WaSend | null> {
  const [row] = await db`
    SELECT * FROM wa_sends WHERE group_jid = ${groupJid} AND message_id = ${messageId}
  `
  return row ? toSend(row) : null
}

export async function setSendMessageId(
  id: number,
  messageId: string,
  groupJid: string,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE wa_sends SET message_id = ${messageId}, group_jid = ${groupJid}, updated_at = NOW()
    WHERE id = ${id}
  `
}
