import type { NextRequest } from "next/server"

/**
 * The origin a browser used to reach this app.
 *
 * `req.nextUrl.origin` is the origin the *server* was addressed on, which
 * behind a platform proxy is the container's own address — on Railway it comes
 * back as `https://localhost:8080`. Google is then handed a redirect_uri
 * pointing at localhost and refuses the whole sign-in, which is exactly how
 * this surfaced: a redirect that worked locally and could never work deployed.
 *
 * So the forwarded headers win when they are present. They are set by the
 * platform, not the caller — a request arriving from outside cannot forge them
 * past the proxy — and auth.ts already runs `trustHost: true` on the same
 * reasoning.
 *
 * PUBLIC_ORIGIN overrides both, for the case where the proxy does not say.
 */
export function publicOrigin(req: NextRequest): string {
  const configured = (process.env.PUBLIC_ORIGIN ?? "").replace(/\/$/, "")
  if (/^https?:\/\//.test(configured)) return configured

  // A comma-separated chain means several proxies; the first entry is the one
  // the browser actually used.
  const host = (req.headers.get("x-forwarded-host") ?? "").split(",")[0].trim()
  if (host) {
    const proto = (req.headers.get("x-forwarded-proto") ?? "https").split(",")[0].trim()
    return `${proto}://${host}`
  }
  return req.nextUrl.origin
}
