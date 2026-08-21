import { randomBytes, createHmac, timingSafeEqual } from "node:crypto"

/**
 * The `state` parameter carried through Google's OAuth redirect.
 *
 * It has to survive a round trip through the browser, which means the browser
 * can edit it. It carries the invite token, and an invite token decides which
 * customer a Google account gets bound to — so an unsigned state would let
 * anyone bind their own Google account to a customer of their choosing by
 * editing the URL mid-flow. Hence the HMAC.
 *
 * Format: <nonce>.<inviteToken>.<siteNonce>.<hmac>. The invite may be empty,
 * which is how a returning customer signs in with no invite at all.
 *
 * siteNonce is the catalogue site's own login nonce. It is carried here rather
 * than in a bare query parameter so the browser cannot swap it mid-flow: the
 * catalogue refuses any code whose nonce does not match the cookie it set
 * before the round trip, which is what stops an attacker's code being
 * redeemed in a victim's browser.
 */

function secret(): string {
  const value = process.env.AUTH_SECRET
  if (!value) throw new Error("AUTH_SECRET is required to sign the customer OAuth state")
  return value
}

function mac(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url")
}

export function signState(invite: string, siteNonce = ""): string {
  // The random part makes two sign-ins with the same invite produce different
  // state values, so one cannot be replayed as the other.
  const payload = `${randomBytes(16).toString("base64url")}.${invite}.${siteNonce}`
  return `${payload}.${mac(payload)}`
}

export function verifyState(state: string): { invite: string; siteNonce: string } | null {
  // Every part is base64url and contains no dots, so exactly four.
  const parts = state.split(".")
  if (parts.length !== 4) return null
  const [nonce, invite, siteNonce, provided] = parts

  const expected = mac(`${nonce}.${invite}.${siteNonce}`)
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  return { invite, siteNonce }
}
