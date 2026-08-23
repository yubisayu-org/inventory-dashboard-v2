import { NextRequest, NextResponse } from "next/server"
import { publicOrigin } from "@/lib/public-origin"
import { signState } from "@/lib/catalogue-oauth-state"

// Start of the customer sign-in flow. Deliberately NOT NextAuth: auth.ts
// derives a staff role from an email allowlist, and a customer picking up a
// role would be a privilege escalation. Same Google OAuth client, separate
// exchange, separate session store.

export async function GET(req: NextRequest) {
  const invite = req.nextUrl.searchParams.get("invite") ?? ""
  // Set by the catalogue before it sent the customer here, and handed
  // back on the callback so it can prove the sign-in started in this
  // same browser.
  const siteNonce = req.nextUrl.searchParams.get("nonce") ?? ""

  // Reached without a nonce, which means the sign-in did not start on the
  // catalogue. Going on would redeem the invite and then fail the exchange,
  // spending the invite on an attempt that cannot succeed. Send them to the
  // catalogue to begin properly instead.
  if (!siteNonce) {
    const site = (process.env.CATALOGUE_SITE_URL ?? "").replace(/\/$/, "")
    if (/^https?:\/\//.test(site)) {
      const start = new URL(`${site}/`)
      if (invite) start.searchParams.set("invite", invite)
      return NextResponse.redirect(start.toString())
    }
  }

  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) {
    console.error("GOOGLE_CLIENT_ID is not configured")
    return NextResponse.json({ error: "Sign-in is unavailable" }, { status: 500 })
  }

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  url.searchParams.set("client_id", clientId)
  // The origin the BROWSER used, not the one this process was addressed on:
  // behind Railway's proxy the latter is https://localhost:8080, and Google
  // refuses a redirect_uri pointing there. Same trust reasoning as auth.ts's
  // trustHost: true.
  url.searchParams.set("redirect_uri", `${publicOrigin(req)}/customer/callback`)
  url.searchParams.set("response_type", "code")
  // openid alone: this flow needs a stable subject id and nothing else. No
  // profile, no email, no contacts.
  url.searchParams.set("scope", "openid")
  url.searchParams.set("state", signState(invite, siteNonce))

  return NextResponse.redirect(url)
}
