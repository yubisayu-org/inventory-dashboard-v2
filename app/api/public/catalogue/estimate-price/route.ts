import { NextRequest, NextResponse } from "next/server"
import catalogueSql from "@/lib/db-catalogue-public"
import { calcAbroadPrice } from "@/lib/pricing"

// Public, no-login endpoint estimating a price for a custom order request,
// from a foreign-currency purchase price and weight. Computes server-side
// using the country's real kurs/cargo_per_kg (readable by this connection
// per migration 063, never included in the response) and the same
// calcAbroadPrice formula the "Profit Margin" product pricing method
// already uses in production — fixed 15% margin, no fees. Returns ONLY the
// final price: `.cogs` (landed cost) is deliberately never returned, since
// a caller who knows their own valas/gram could otherwise back out kurs.
// See docs/superpowers/specs/2026-08-16-custom-request-price-estimate-design.md.
//
// TODO: swap for the real domain once the catalogue site is deployed.
const ALLOWED_ORIGIN = "https://yubisayu-catalogue.netlify.app"

const MAX_BODY_BYTES = 1024
const PROFIT_PCT = 15
const ROUND_TO = 1000

// A single response never reveals kurs/cogs, but many responses do: an attacker who
// binary-searches valas/gram for the exact point where estimatedPrice flips to the next
// rounded value can solve for kurs algebraically. Access-Control-Allow-Origin does not stop
// this — it's a response header a browser enforces, not a check this server makes, so a
// direct curl/script bypasses it and the video-catalog site's separate Netlify-proxy rate
// limit entirely. This mirrors the in-memory per-IP limiter already used by that feature's
// Netlify Function proxies (video-catalog repo). Safe here because this app runs as a
// persistent Railway Node process, not per-request serverless, so the Map survives between
// requests within a process.
const rateLimitMap = new Map<string, { windowStart: number; count: number }>()
const RATE_LIMIT_WINDOW = 60_000 // 1 minute
const RATE_LIMIT_MAX = 20 // generous enough for normal debounced form use, throttles a 54-request bisection to multiple minutes minimum

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  let entry = rateLimitMap.get(ip)
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    entry = { windowStart: now, count: 1 }
    rateLimitMap.set(ip, entry)
    return false
  }
  entry.count++
  return entry.count > RATE_LIMIT_MAX
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function POST(req: NextRequest) {
  const declaredLen = Number(req.headers.get("content-length") ?? 0)
  if (declaredLen > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: corsHeaders() })
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: corsHeaders() })
  }

  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: corsHeaders() })
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() })
  }
  if (typeof body !== "object" || body === null) body = {}

  try {
    const b = body as Record<string, unknown>
    const countryId = Number(b.countryId)
    const valas = Number(b.valas)
    const gram = Number(b.gram)

    if (!Number.isInteger(countryId) || countryId < 1) {
      return NextResponse.json({ error: "countryId must be a positive integer" }, { status: 400, headers: corsHeaders() })
    }
    if (!Number.isFinite(valas) || valas <= 0) {
      return NextResponse.json({ error: "valas must be a positive number" }, { status: 400, headers: corsHeaders() })
    }
    if (!Number.isFinite(gram) || gram <= 0) {
      return NextResponse.json({ error: "gram must be a positive number" }, { status: 400, headers: corsHeaders() })
    }

    const [country] = await catalogueSql`
      SELECT kurs, cargo_per_kg FROM countries WHERE id = ${countryId}
    `
    if (!country) {
      return NextResponse.json({ error: "Country not found" }, { status: 404, headers: corsHeaders() })
    }

    const { price } = calcAbroadPrice({
      valas,
      kurs: Number(country.kurs),
      gram,
      cargoPerKg: country.cargo_per_kg as number,
      profitPct: PROFIT_PCT,
      operationalFee: 0,
      packingFee: 0,
      roundTo: ROUND_TO,
    })

    return NextResponse.json({ estimatedPrice: price }, { headers: corsHeaders() })
  } catch (err) {
    console.error("Failed to estimate price:", err)
    return NextResponse.json({ error: "Failed to estimate price" }, { status: 500, headers: corsHeaders() })
  }
}
