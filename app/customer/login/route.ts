import { NextRequest, NextResponse } from "next/server"
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

  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) {
    console.error("GOOGLE_CLIENT_ID is not configured")
    return NextResponse.json({ error: "Sign-in is unavailable" }, { status: 500 })
  }

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  url.searchParams.set("client_id", clientId)
  // Derived from the request rather than an env var, matching auth.ts's
  // trustHost: true — the app already trusts the platform proxy's host.
  url.searchParams.set("redirect_uri", `${req.nextUrl.origin}/customer/callback`)
  url.searchParams.set("response_type", "code")
  // openid alone: this flow needs a stable subject id and nothing else. No
  // profile, no email, no contacts.
  url.searchParams.set("scope", "openid")
  url.searchParams.set("state", signState(invite, siteNonce))

  return NextResponse.redirect(url)
}
