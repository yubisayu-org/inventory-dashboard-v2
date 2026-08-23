import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getCountryRate, getProductDefaults, getTierKursInputs } from "@/lib/db"
import { calcAbroadPrice, calcKursPrice, abroadProfit, kursProfit } from "@/lib/pricing"
import { resolveTieredKurs } from "@/lib/kurs-tiers"

const ROUND_TO = 1000

// Owner-only, read-only, side-effect-free live preview for the Edit modal —
// the same computation editCatalogueRequest (lib/db/catalogue-requests.ts)
// performs when actually submitting, exposed here so the owner sees the
// price before committing to an offer_pending state.
export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const params = req.nextUrl.searchParams
  const countryId = Number(params.get("countryId"))
  const valas = Number(params.get("valas"))
  const gram = Number(params.get("gram"))

  if (!Number.isInteger(countryId) || countryId < 1) {
    return NextResponse.json({ error: "countryId must be a positive integer" }, { status: 400 })
  }
  if (!Number.isFinite(valas) || valas <= 0) {
    return NextResponse.json({ error: "valas must be a positive number" }, { status: 400 })
  }
  if (!Number.isFinite(gram) || gram <= 0) {
    return NextResponse.json({ error: "gram must be a positive number" }, { status: 400 })
  }

  const pricingMethod = params.get("pricingMethod") === "tier_kurs" ? "tier_kurs" : "overseas"
  // Optional — same fallback as editCatalogueRequest (Settings' customRequest*
  // fields, migration 090), so the preview always matches what submitting
  // without touching these fields would produce.
  const defaults = await getProductDefaults()
  const packingFee = params.has("packingFee") ? Number(params.get("packingFee")) : defaults.customRequestPackingFee

  try {
    const rate = await getCountryRate(countryId)
    if (!rate) return NextResponse.json({ error: "Country not found" }, { status: 400 })

    if (pricingMethod === "tier_kurs") {
      // Server-resolved, same as computeProductPrice's own tier_kurs branch —
      // never trusts a caller-supplied rate.
      const { kursTiers, roundTo } = await getTierKursInputs(countryId)
      const tieredKurs = resolveTieredKurs(kursTiers, valas, rate.kurs)
      const { price, cogs } = calcKursPrice({
        valas, chargedKurs: tieredKurs, kurs: rate.kurs, gram, cargoPerKg: rate.cargoPerKg,
        packingFee, roundTo,
      })
      const profit = kursProfit({ price, cogs, packingFee })
      return NextResponse.json(
        { estimatedPrice: price, profit, tieredKurs },
        { headers: { "Cache-Control": "no-store" } },
      )
    }

    const profitPct = params.has("profitPct") ? Number(params.get("profitPct")) : defaults.customRequestProfitPct
    const operationalFee = params.has("operationalFee") ? Number(params.get("operationalFee")) : defaults.customRequestOperationalFee

    const { price, cogs } = calcAbroadPrice({
      valas, kurs: rate.kurs, gram, cargoPerKg: rate.cargoPerKg,
      profitPct, operationalFee, packingFee, roundTo: ROUND_TO,
    })
    const profit = abroadProfit({ price, cogs, operationalFee, packingFee })
    return NextResponse.json({ estimatedPrice: price, profit }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to preview price:", err)
    return NextResponse.json({ error: "Failed to preview price" }, { status: 500 })
  }
}
