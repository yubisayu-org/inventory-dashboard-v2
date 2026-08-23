// Shared CORS/handshake headers for the public catalogue endpoints.
//
// These answer the catalogue site's server-side Netlify proxies, not a
// browser, so CORS is belt-and-braces rather than load-bearing — but the
// existing routes set it and consistency is worth more than the saving.
const ALLOWED_ORIGIN = process.env.CATALOGUE_SITE_URL ?? "https://yubisayu-catalogue.netlify.app"

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN.replace(/\/$/, ""),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  }
}

/** Customer-specific data must never be cached by anything in between. */
export function privateHeaders(): Record<string, string> {
  return { ...corsHeaders(), "Cache-Control": "no-store" }
}
