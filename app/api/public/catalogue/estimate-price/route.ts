import { NextRequest, NextResponse } from "next/server"
import catalogueSql from "@/lib/db-catalogue-public"
import { calcAbroadPrice, ceilTo } from "@/lib/pricing"

// Public, no-login endpoint estimating a price for a custom order request,
// from a foreign-currency purchase price and weight. Computes server-side
// using the country's real kurs/cargo_per_kg (readable by this connection
// per migration 063, never included in the response) and the same
// calcAbroadPrice formula the "Profit Margin" product pricing method
// already uses in production — fixed 15% margin, no fees. Returns ONLY the
// final price: `.cogs` (landed cost) is deliberately never returned.
//
// A single unbounded, precisely-rounded response is itself an oracle: price
// is an affine function of kurs with publicly known coefficients, so an
// attacker who controls valas's magnitude can drive the relative rounding
// error to near zero and solve for kurs algebraically from ONE request (no
// bisection needed). Mitigated three ways: input bounds (VALAS_MIN/MAX,
// GRAM_MIN/MAX below), server-side input quantization (quantizeSigFigs /
// quantizeGram — shrinks the reachable input space), and relative-precision
// output rounding (roundEstimate — bounds a SINGLE response to disclosing
// kurs within roughly ±0.3%, regardless of input magnitude).
//
// This bounds one request, not sustained probing: the reachable
// (valas, gram) grid is finite (currently ~450 x ~5000 cells), and an
// attacker issuing many requests across that grid narrows the feasible
// range further, converging roughly as 1/N — a few hundred requests can
// still reach single-digit-percent precision. Per-IP rate limiting below
// remains load-bearing for that sustained case, not merely
// belt-and-braces. Fully closing sustained-request narrowing (e.g. a
// shared secret between the video-catalog proxy and this route, so it
// can't be called directly at volume) is deferred — see
// .superpowers/sdd/2026-08-16-custom-request-price-estimate-backend/progress.md.
// See docs/superpowers/specs/2026-08-16-custom-request-price-estimate-design.md.
//
// TODO: swap for the real domain once the catalogue site is deployed.
const ALLOWED_ORIGIN = "https://yubisayu-catalogue.netlify.app"

const MAX_BODY_BYTES = 1024
const PROFIT_PCT = 15
const ROUND_TO = 1000

const VALAS_MIN = 1
// Currency-agnostic on purpose — valas is in whatever the country's own
// currency is (JPY/KRW/VND-scale orders can legitimately be six-plus
// figures). Raising this buys an attacker nothing: the disclosure bound
// comes from the relative output rounding in roundEstimate(), not from
// valas's magnitude.
const VALAS_MAX = 100_000_000
const GRAM_MIN = 1
const GRAM_MAX = 50_000

// Snaps a positive number to `sigFigs` significant figures.
function quantizeSigFigs(n: number, sigFigs: number): number {
  const magnitude = Math.floor(Math.log10(n))
  const step = 10 ** (magnitude - (sigFigs - 1))
  return Math.round(n / step) * step
}

// Snaps gram to 10g buckets, never below the bucket size. A coarser
// bucket (previously 100g) meaningfully distorted realistic small-item
// estimates (e.g. a 40g item quoting ~34% high) for little extra
// disclosure resistance, since the output rounding is the dominant
// disclosure bound, not this quantization step.
function quantizeGram(g: number): number {
  return Math.max(10, Math.round(g / 10) * 10)
}

// Rounds an estimate to ~3 significant figures (never coarser than the
// original fixed ROUND_TO), so single-response disclosure stays bounded
// regardless of how large the computed price is.
function roundEstimate(price: number): number {
  const magnitude = Math.floor(Math.log10(price))
  const relativeStep = 10 ** (magnitude - 2)
  return ceilTo(price, Math.max(ROUND_TO, relativeStep))
}

// Secondary defense only — see the block comment above. Keys on the
// last X-Forwarded-For hop (the one this app's own edge proxy appends,
// not one a client can inject by prepending fake entries), falling back
// to a platform real-IP header if present. Evicts expired entries once
// the map grows past a threshold so a spoofing attacker can't grow it
// unboundedly on a long-lived process.
const rateLimitMap = new Map<string, { windowStart: number; count: number }>()
const RATE_LIMIT_WINDOW = 60_000 // 1 minute
const RATE_LIMIT_MAX = 20
const RATE_LIMIT_MAP_SWEEP_THRESHOLD = 1000
// Hard cap below the sweep threshold: a script rotating its IP/XFF header
// faster than entries expire would otherwise keep the map growing forever
// even with the sweep, since sweeping only removes already-expired
// entries. If still over threshold post-sweep, drop oldest-inserted
// entries (Map iterates in insertion order) until back under it.
const RATE_LIMIT_MAP_HARD_CAP = 1000

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  if (rateLimitMap.size > RATE_LIMIT_MAP_SWEEP_THRESHOLD) {
    for (const [key, entry] of rateLimitMap) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW) rateLimitMap.delete(key)
    }
    if (rateLimitMap.size > RATE_LIMIT_MAP_HARD_CAP) {
      const excess = rateLimitMap.size - RATE_LIMIT_MAP_HARD_CAP
      const oldestKeys = Array.from(rateLimitMap.keys()).slice(0, excess)
      for (const key of oldestKeys) rateLimitMap.delete(key)
    }
  }
  let entry = rateLimitMap.get(ip)
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    entry = { windowStart: now, count: 1 }
    rateLimitMap.set(ip, entry)
    return false
  }
  entry.count++
  return entry.count > RATE_LIMIT_MAX
}

function clientIp(req: NextRequest): string {
  // The last X-Forwarded-For hop is safe by construction on this app's
  // deployment (Railway/Envoy appends the real client IP as the final
  // entry) regardless of how many fake entries a client prepends, so it's
  // checked first. x-envoy-external-address is only a fallback: it's
  // trustworthy only if the edge actually sets it, which isn't verified
  // here — see the block comment above this route for the open topology
  // question.
  const xff = req.headers.get("x-forwarded-for")
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim())
    const last = hops[hops.length - 1]
    if (last) return last
  }
  const envoyIp = req.headers.get("x-envoy-external-address")
  if (envoyIp) return envoyIp
  return "unknown"
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

  const ip = clientIp(req)
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
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() })
  }

  try {
    const b = body as Record<string, unknown>
    const countryId = Number(b.countryId)
    const valas = Number(b.valas)
    const gram = Number(b.gram)

    if (!Number.isInteger(countryId) || countryId < 1) {
      return NextResponse.json({ error: "countryId must be a positive integer" }, { status: 400, headers: corsHeaders() })
    }
    if (!Number.isFinite(valas) || valas < VALAS_MIN || valas > VALAS_MAX) {
      return NextResponse.json({ error: `valas must be between ${VALAS_MIN} and ${VALAS_MAX}` }, { status: 400, headers: corsHeaders() })
    }
    if (!Number.isFinite(gram) || gram < GRAM_MIN || gram > GRAM_MAX) {
      return NextResponse.json({ error: `gram must be between ${GRAM_MIN} and ${GRAM_MAX}` }, { status: 400, headers: corsHeaders() })
    }

    const quantizedValas = quantizeSigFigs(valas, 2)
    const quantizedGram = quantizeGram(gram)

    const [country] = await catalogueSql`
      SELECT kurs, cargo_per_kg FROM countries WHERE id = ${countryId}
    `
    if (!country) {
      return NextResponse.json({ error: "Country not found" }, { status: 404, headers: corsHeaders() })
    }

    const { price: rawPrice } = calcAbroadPrice({
      valas: quantizedValas,
      kurs: Number(country.kurs),
      gram: quantizedGram,
      cargoPerKg: Number(country.cargo_per_kg),
      profitPct: PROFIT_PCT,
      operationalFee: 0,
      packingFee: 0,
      roundTo: 1,
    })

    return NextResponse.json({ estimatedPrice: roundEstimate(rawPrice) }, { headers: corsHeaders() })
  } catch (err) {
    console.error("Failed to estimate price:", err)
    return NextResponse.json({ error: "Failed to estimate price" }, { status: 500, headers: corsHeaders() })
  }
}
