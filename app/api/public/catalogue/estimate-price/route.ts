import { NextRequest, NextResponse } from "next/server"
import catalogueSql from "@/lib/db-catalogue-public"
import { calcAbroadPrice, ceilTo } from "@/lib/pricing"
import { clientIp, createRateLimiter } from "@/lib/catalogue-rate-limit"

// Public, no-login endpoint estimating a price for a custom order request,
// from a foreign-currency purchase price and weight. Computes server-side
// using the country's real kurs/cargo_per_kg (readable by this connection
// per migration 078, never included in the response) and the same
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
// Matches product_defaults.operational_fee today, but deliberately a constant
// rather than a read of that table: this estimate is a customer-facing quote,
// and changing a pricing default should not silently move what customers are
// quoted. Note the estimate still sits below the real price — product_defaults
// currently carries a 30% margin and a 5000 packing fee that this does not
// apply.
const OPERATIONAL_FEE = 5000
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

// Secondary defense only — see the block comment above. Evicts expired
// entries once the map grows past a threshold so a spoofing attacker
// can't grow it unboundedly on a long-lived process. See
// lib/catalogue-rate-limit.ts for clientIp()'s last-XFF-hop logic and the
// sweep/hard-cap details — shared across all public catalogue routes, but
// this route gets its own independent counter (own createRateLimiter()
// call), matching the approve/reject routes.
const isRateLimited = createRateLimiter(60_000, 20)

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
      operationalFee: OPERATIONAL_FEE,
      packingFee: 0,
      roundTo: 1,
    })

    return NextResponse.json({ estimatedPrice: roundEstimate(rawPrice) }, { headers: corsHeaders() })
  } catch (err) {
    console.error("Failed to estimate price:", err)
    return NextResponse.json({ error: "Failed to estimate price" }, { status: 500, headers: corsHeaders() })
  }
}
