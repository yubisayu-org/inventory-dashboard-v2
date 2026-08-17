import sql from "@/lib/db-pool"
import { normalizeCustomer } from "@/lib/db/helpers"
import { normalizeNumber } from "@/lib/db/whatsapp-groups"

/**
 * The digits-only form of customers.whatsapp, as SQL.
 *
 * That column holds whatever a human typed — "0811-2233-4455",
 * "+62 811 2233 4455", sometimes with a note after it — so a comparison has to
 * strip both sides rather than trust the stored spelling. Done in SQL so this
 * stays one query over a small table instead of pulling every customer into
 * memory to normalize.
 */
const STORED_DIGITS = sql`
  CASE WHEN regexp_replace(whatsapp, '\\D', '', 'g') LIKE '0%'
       THEN '62' || substring(regexp_replace(whatsapp, '\\D', '', 'g') from 2)
       ELSE regexp_replace(whatsapp, '\\D', '', 'g')
  END
`

/** Which customer a WhatsApp number belongs to, or null. */
export async function findCustomerByNumber(number: string): Promise<string | null> {
  const digits = normalizeNumber(number)
  if (!digits) return null

  const [row] = await sql`
    SELECT instagram_id FROM customers
    WHERE whatsapp <> '' AND ${STORED_DIGITS} = ${digits}
    ORDER BY id ASC
    LIMIT 1
  `
  return row ? (row.instagram_id as string) : null
}

/**
 * Fill in the customers a post's claims already imply.
 *
 * Returns how many were matched. Claims whose sender is not on file are moved to
 * review rather than left pending: they are not broken, but nobody can be
 * invoiced for them until a human says who sent them.
 *
 * Auto-creating a customer keyed by phone is deliberately not done. Orders,
 * invoices, payments and the public invoice site all key on the Instagram
 * handle, and a phone-keyed row would be a second namespace drifting beside it.
 */
export async function resolveSenders(postId: number): Promise<number> {
  const rows = await sql`
    SELECT id, sender FROM wa_claims
    WHERE post_id = ${postId} AND customer IS NULL AND state <> 'rejected'
  `

  let matched = 0
  for (const row of rows) {
    const handle = await findCustomerByNumber(row.sender as string)
    if (handle === null) {
      await sql`
        UPDATE wa_claims SET state = 'review', updated_at = NOW() WHERE id = ${row.id}
      `
      continue
    }
    await sql`
      UPDATE wa_claims SET customer = ${handle}, updated_at = NOW() WHERE id = ${row.id}
    `
    matched += 1
  }
  return matched
}

/**
 * Ask once, remember forever.
 *
 * Writes the number onto the customer record so every future claim from it
 * resolves without asking, and backfills the claims that were already waiting on
 * the answer — otherwise answering would fix the future and strand the present.
 *
 * The number is stored normalized. The spellings already in the table are left
 * alone: findCustomerByNumber copes with them, and rewriting a customer's own
 * record as a side effect of a WhatsApp reply is not this function's business.
 */
export async function linkSenderToCustomer(number: string, handle: string): Promise<void> {
  const digits = normalizeNumber(number)
  const customer = normalizeCustomer(handle)
  if (!digits || !customer) throw new Error("a number and a handle are both required")

  await sql.begin(async (tx) => {
    const [exists] = await tx`SELECT 1 FROM customers WHERE instagram_id = ${customer}`
    if (!exists) throw new Error(`no such customer: ${customer}`)

    await tx`UPDATE customers SET whatsapp = ${digits} WHERE instagram_id = ${customer}`
    await tx`
      UPDATE wa_claims
      SET customer = ${customer},
          state = CASE WHEN state = 'review' THEN 'pending' ELSE state END,
          updated_at = NOW()
      WHERE customer IS NULL AND state <> 'rejected'
        AND regexp_replace(sender, '\\D', '', 'g') = ${digits}
    `
  })
}

/**
 * Read an Instagram handle out of a reply, or decide it was not one.
 *
 * Deliberately strict. This runs on ordinary group chatter from someone the bot
 * has just asked a question, and mistaking "iya kak" for a handle would link a
 * customer record to the wrong person — a mistake that then quietly attaches
 * their orders to a stranger.
 *
 * A handle must therefore be the whole message, use only the characters
 * Instagram allows, and contain a letter: a bare number is far more likely to be
 * a size than a username.
 */
export function parseHandle(text: string): string | null {
  const bare = text.trim().replace(/^@+/, "")
  if (!/^[A-Za-z0-9._]{2,30}$/.test(bare)) return null
  if (!/[A-Za-z]/.test(bare)) return null
  return bare.toLowerCase()
}

/** Whether this number has ever been asked who they are. */
export async function hasBeenAsked(number: string): Promise<boolean> {
  const [row] = await sql`
    SELECT 1 FROM wa_identity_asks WHERE number = ${normalizeNumber(number)}
  `
  return Boolean(row)
}

/** Remember that the question went out, so it never goes out twice. */
export async function recordAsk(number: string, messageId: string): Promise<void> {
  await sql`
    INSERT INTO wa_identity_asks (number, message_id)
    VALUES (${normalizeNumber(number)}, ${messageId})
    ON CONFLICT (number) DO NOTHING
  `
}

/** The unanswered question put to this number, if there is one. */
export async function pendingAsk(number: string): Promise<{ messageId: string } | null> {
  const [row] = await sql`
    SELECT message_id FROM wa_identity_asks
    WHERE number = ${normalizeNumber(number)} AND answered_at IS NULL
  `
  return row ? { messageId: (row.message_id as string) ?? "" } : null
}

/**
 * Accept an answer to the identity question.
 *
 * Refuses a handle nobody has: auto-creating a customer keyed off whatever
 * someone typed is exactly the second namespace this design rules out, and a
 * typo would create a customer nobody can ever find again.
 */
export async function answerAsk(number: string, handle: string): Promise<boolean> {
  const [exists] = await sql`SELECT 1 FROM customers WHERE instagram_id = ${handle}`
  if (!exists) return false

  await linkSenderToCustomer(number, handle)
  await sql`
    UPDATE wa_identity_asks SET answered_at = NOW() WHERE number = ${normalizeNumber(number)}
  `
  return true
}
