import { randomBytes, createHash } from "node:crypto"
import sql from "./db-pool"

// Sixty seconds is a redirect, not a user journey: the browser is handed this
// code and immediately spends it. Anything longer just widens the window in
// which a code sitting in a log is still worth something.
const TTL_SECONDS = 60

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/**
 * Hand the catalogue site a way to obtain a session, without the session
 * itself ever appearing in a URL.
 *
 * A session token would otherwise land in browser history, the next request's
 * Referer header, and every access log in between — a ninety-day credential
 * scattered across places nobody audits.
 *
 * This table deliberately holds NO credential: a hashed code and a customer
 * id. The session is minted when the code is spent, so a dump of it yields
 * nothing usable. The code is hashed for the same reason invites and sessions
 * are.
 */
export async function putOneTimeCode(customerId: number): Promise<string> {
  const code = randomBytes(24).toString("base64url")
  await sql`
    INSERT INTO customer_one_time_codes (code, customer_id, expires_at)
    VALUES (${hash(code)}, ${customerId}, NOW() + ${`${TTL_SECONDS} seconds`}::interval)
  `
  return code
}

/**
 * Spend a code, returning the customer it was minted for.
 *
 * DELETE ... RETURNING rather than SELECT-then-DELETE: two concurrent requests
 * with the same code must not both succeed, and only a single statement
 * guarantees that.
 *
 * Expired rows are swept here rather than by a job nothing calls.
 */
export async function takeOneTimeCode(code: string): Promise<number | null> {
  const [row] = await sql<{ customer_id: number }[]>`
    DELETE FROM customer_one_time_codes
     WHERE code = ${hash(code)} AND expires_at > NOW()
    RETURNING customer_id
  `
  await sql`DELETE FROM customer_one_time_codes WHERE expires_at <= NOW()`
  return row?.customer_id ?? null
}
