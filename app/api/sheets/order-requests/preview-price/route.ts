import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getCountryRate } from "@/lib/db"
import { calcAbroadPrice } from "@/lib/pricing"

const PROFIT_PCT = 15
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

  try {
    const rate = await getCountryRate(countryId)
    if (!rate) return NextResponse.json({ error: "Country not found" }, { status: 400 })

    const { price } = calcAbroadPrice({
      valas, kurs: rate.kurs, gram, cargoPerKg: rate.cargoPerKg,
      profitPct: PROFIT_PCT, operationalFee: 0, packingFee: 0, roundTo: ROUND_TO,
    })
    return NextResponse.json({ estimatedPrice: price }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to preview price:", err)
    return NextResponse.json({ error: "Failed to preview price" }, { status: 500 })
  }
}
