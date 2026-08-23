import { NextRequest, NextResponse } from "next/server"
import { verifyState } from "@/lib/catalogue-oauth-state"
import { redeemInvite, signInByGoogleSub } from "@/lib/db/catalogue-auth"
import { putOneTimeCode } from "@/lib/catalogue-one-time-code"

// Google hands the browser back here. Bind or sign in, then send the customer
// to the catalogue site with a one-time code it can trade for a cookie.

function siteOrigin(): string | null {
  const site = (process.env.CATALOGUE_SITE_URL ?? "").replace(/\/$/, "")
  // Relative values make NextResponse.redirect throw, which turned a
  // configuration gap into a 500 on BOTH the success and failure paths —
  // including the one that exists to report failures.
  return /^https?:\/\//.test(site) ? site : null
}

function backToSite(reason: string): NextResponse {
  const site = siteOrigin()
  if (!site) {
    console.error("CATALOGUE_SITE_URL is not configured")
    return NextResponse.json(
      { error: "Sign-in is not configured. Please contact the shop." },
      { status: 500 },
    )
  }
  return NextResponse.redirect(`${site}/?auth=${reason}`)
}

/**
 * Read `sub` out of the id_token.
 *
 * The signature is not verified because this token came straight from Google's
 * token endpoint over TLS in a server-to-server call — there is no untrusted
 * party in between. If this ever moves to a flow where the browser delivers
 * the token, the signature MUST be checked against Google's JWKS.
 */
function subjectFromIdToken(idToken: string): string | null {
  const parts = idToken.split(".")
  if (parts.length !== 3) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    return typeof claims.sub === "string" && claims.sub ? claims.sub : null
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code")
  const state = req.nextUrl.searchParams.get("state")
  if (!code || !state) return backToSite("failed")

  const verified = verifyState(state)
  if (!verified) return backToSite("failed")

  let googleSub: string | null = null
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${req.nextUrl.origin}/customer/callback`,
        grant_type: "authorization_code",
      }),
    })
    if (!tokenRes.ok) {
      console.error("Google token exchange failed:", tokenRes.status)
      return backToSite("failed")
    }
    const payload = (await tokenRes.json()) as { id_token?: string }
    googleSub = payload.id_token ? subjectFromIdToken(payload.id_token) : null
  } catch (err) {
    console.error("Google token exchange errored:", err)
    return backToSite("failed")
  }
  if (!googleSub) return backToSite("failed")

  // With an invite: bind this Google account to that invite's customer.
  // Without one: only an already-bound account gets in.
  const result = verified.invite
    ? await redeemInvite(verified.invite, googleSub)
    : await signInByGoogleSub(googleSub)

  if (!result) return backToSite("unknown")
  if ("error" in result) return backToSite(result.error)

  // No session yet: the code stands for the customer, and the session is
  // minted when it is spent. An abandoned sign-in therefore leaves no live
  // credential behind at all.
  const oneTime = await putOneTimeCode(result.customerId)
  const site = siteOrigin()
  if (!site) return backToSite("failed")
  // The nonce goes back so the catalogue can check it against the cookie it
  // set before this round trip. A code arriving without the matching nonce is
  // refused there, which is what stops one browser's code being redeemed in
  // another's.
  const back = new URL(`${site}/api/auth-exchange`)
  back.searchParams.set("code", oneTime)
  if (verified.siteNonce) back.searchParams.set("nonce", verified.siteNonce)
  return NextResponse.redirect(back.toString())
}
