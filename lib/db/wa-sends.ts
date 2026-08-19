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

    const existing = await tx`SELECT code FROM wa_send_codes WHERE event = ${send.event}`
    const code = nextCode(existing.map((r) => r.code as string))

    const [position] = await tx`SELECT count(*)::int AS n FROM wa_send_codes WHERE send_id = ${sendId}`

    const [row] = await tx`
      INSERT INTO wa_send_codes (send_id, product_id, code, event, price, position)
      VALUES (${sendId}, ${productId}, ${code}, ${send.event}, ${product.price}, ${position.n})
      RETURNING *
    `
    return toSendCode({ ...row, product_name: product.name })
  })
}

export async function getSendCodeByCode(
  event: string,
  code: string,
  db: DBExecutor = sql,
): Promise<WaSendCode | null> {
  const [row] = await db`
    SELECT c.*, p.name AS product_name
    FROM wa_send_codes c JOIN products p ON p.id = c.product_id
    WHERE c.event = ${event} AND c.code = ${code}
  `
  return row ? toSendCode(row) : null
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
