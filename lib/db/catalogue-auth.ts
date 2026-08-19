import { randomBytes, createHash } from "node:crypto"
import sql from "../db-pool"
import type { DBExecutor } from "./actor"

// Two weeks: the shop sends these by hand over Instagram or WhatsApp, so the
// window has to survive a customer not checking their messages for a while.
const INVITE_TTL_HOURS = 24 * 14
// Matches the catalogue site's cookie Max-Age.
const SESSION_TTL_DAYS = 90

/**
 * Tokens are stored only as a hash. The plaintext is returned once, at
 * generation, and never again — a database dump must not yield working
 * invites or sessions.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function newToken(): string {
  return randomBytes(32).toString("base64url")
}

/**
 * Issue an invite, superseding any the customer already has outstanding.
 *
 * Without the supersede, every link the shop has ever sent that customer
 * would stay redeemable — including ones sent to an account they have since
 * lost access to.
 *
 * ttlHours is a parameter only so tests can produce an already-expired invite.
 */
export async function issueInvite(
  customerId: number,
  ttlHours: number = INVITE_TTL_HOURS,
): Promise<string> {
  const token = newToken()
  await sql.begin(async (tx) => {
    await tx`
      UPDATE customer_invites SET superseded_at = NOW()
       WHERE customer_id = ${customerId}
         AND redeemed_at IS NULL AND superseded_at IS NULL
    `
    await tx`
      INSERT INTO customer_invites (customer_id, token_hash, expires_at)
      VALUES (${customerId}, ${hashToken(token)},
              NOW() + ${`${ttlHours} hours`}::interval)
    `
    // Only from a standing start: an already-active customer being re-invited
    // (new phone, lost link) must not be knocked back to 'invited' and lose
    // access in the meantime.
    await tx`
      UPDATE customers SET catalogue_access = 'invited'
       WHERE id = ${customerId} AND catalogue_access IN ('none', 'invited')
    `
  })
  return token
}

export type RedeemResult =
  | { customerId: number }
  | { error: "invalid" | "expired" | "used" | "sub_taken" }

/**
 * Bind a Google account to the invite's customer.
 *
 * The only operation that ever sets google_sub, and it runs on the main pool —
 * catalogue_public has no UPDATE on customers at all.
 */
export async function redeemInvite(token: string, googleSub: string): Promise<RedeemResult> {
  return sql.begin(async (tx) => {
    const [invite] = await tx<
      {
        id: number
        customer_id: number
        expired: boolean
        used: boolean
        superseded: boolean
      }[]
    >`
      SELECT id, customer_id,
             expires_at < NOW()        AS expired,
             redeemed_at IS NOT NULL   AS used,
             superseded_at IS NOT NULL AS superseded
        FROM customer_invites
       WHERE token_hash = ${hashToken(token)}
       FOR UPDATE
    `
    if (!invite) return { error: "invalid" as const }
    if (invite.used) return { error: "used" as const }
    if (invite.expired || invite.superseded) return { error: "expired" as const }

    // One Google account, one customer. Rebinding would silently move a
    // person's whole order history onto someone else's account.
    const [taken] = await tx<{ id: number }[]>`
      SELECT id FROM customers
       WHERE google_sub = ${googleSub} AND id <> ${invite.customer_id}
    `
    if (taken) return { error: "sub_taken" as const }

    await tx`
      UPDATE customers
         SET google_sub = ${googleSub},
             catalogue_access = 'active',
             bound_at = NOW()
       WHERE id = ${invite.customer_id}
    `
    await tx`UPDATE customer_invites SET redeemed_at = NOW() WHERE id = ${invite.id}`
    return { customerId: invite.customer_id }
  })
}

/** Returning customer: no invite needed, the Google account is already bound. */
export async function signInByGoogleSub(
  googleSub: string,
): Promise<{ customerId: number } | null> {
  const [row] = await sql<{ id: number }[]>`
    SELECT id FROM customers
     WHERE google_sub = ${googleSub} AND catalogue_access = 'active'
  `
  return row ? { customerId: row.id } : null
}

export async function issueSession(customerId: number): Promise<string> {
  const token = newToken()
  await sql`
    INSERT INTO customer_sessions (customer_id, token_hash, expires_at)
    VALUES (${customerId}, ${hashToken(token)},
            NOW() + ${`${SESSION_TTL_DAYS} days`}::interval)
  `
  return token
}

/**
 * Resolve a bearer token to a customer.
 *
 * Runs under catalogue_public on the request path, hence the explicit db
 * parameter. catalogue_access is checked here rather than only at sign-in:
 * revoking a customer has to end their live sessions on the next request, not
 * at their next login.
 */
export async function resolveSession(
  token: string,
  db: DBExecutor = sql,
): Promise<{ id: number; instagramId: string } | null> {
  const [row] = await db<{ id: number; instagram_id: string }[]>`
    SELECT c.id, c.instagram_id
      FROM customer_sessions s
      JOIN customers c ON c.id = s.customer_id
     WHERE s.token_hash = ${hashToken(token)}
       AND s.revoked_at IS NULL
       AND s.expires_at > NOW()
       AND c.catalogue_access = 'active'
  `
  return row ? { id: row.id, instagramId: row.instagram_id } : null
}

export async function revokeSession(token: string): Promise<void> {
  await sql`
    UPDATE customer_sessions SET revoked_at = NOW()
     WHERE token_hash = ${hashToken(token)} AND revoked_at IS NULL
  `
}

/**
 * Cut a customer off entirely.
 *
 * Both halves in one transaction: flipping the flag without revoking the
 * sessions would leave resolveSession as the only thing standing between a
 * revoked customer and their data.
 */
export async function revokeCustomer(customerId: number): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`UPDATE customers SET catalogue_access = 'revoked' WHERE id = ${customerId}`
    await tx`
      UPDATE customer_sessions SET revoked_at = NOW()
       WHERE customer_id = ${customerId} AND revoked_at IS NULL
    `
  })
}
