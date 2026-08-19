import { randomBytes } from "node:crypto"
import sql from "./db-pool"

// Sixty seconds is a redirect, not a user journey: the browser is handed this
// code and immediately spends it. Anything longer just widens the window in
// which a code sitting in a log is still worth something.
const TTL_SECONDS = 60

/**
 * Hand the catalogue site a session without putting the session token in a URL.
 *
 * The token would otherwise land in the browser's history, the Referer header
 * of the next request, and every access log between here and there — all for a
 * credential that lasts ninety days. This code lasts one minute and one use.
 */
export async function putOneTimeCode(sessionToken: string): Promise<string> {
  const code = randomBytes(24).toString("base64url")
  await sql`
    INSERT INTO customer_one_time_codes (code, session_token, expires_at)
    VALUES (${code}, ${sessionToken}, NOW() + ${`${TTL_SECONDS} seconds`}::interval)
  `
  return code
}

/**
 * Spend a code.
 *
 * DELETE ... RETURNING rather than SELECT-then-DELETE: two concurrent requests
 * with the same code must not both receive the session, and only a single
 * statement guarantees that.
 */
export async function takeOneTimeCode(code: string): Promise<string | null> {
  const [row] = await sql<{ session_token: string }[]>`
    DELETE FROM customer_one_time_codes
     WHERE code = ${code} AND expires_at > NOW()
    RETURNING session_token
  `
  return row?.session_token ?? null
}

/** Housekeeping for codes nobody ever spent. Safe to call at any time. */
export async function purgeExpiredOneTimeCodes(): Promise<void> {
  await sql`DELETE FROM customer_one_time_codes WHERE expires_at <= NOW()`
}
