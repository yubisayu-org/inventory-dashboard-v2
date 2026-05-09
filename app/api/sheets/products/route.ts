import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getProducts, addProduct, getCountries } from "@/lib/db"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const [products, countries] = await Promise.all([getProducts(), getCountries()])
    return NextResponse.json({ products, countries }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to load products:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const body = await req.json()
    const { name, store } = body
    if (!String(name ?? "").trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 })
    }

    const result = await addProduct({
      name: String(name).trim(),
      store: String(store ?? "").trim(),
      price: Number(body.price) || 0,
      gram: Number(body.gram) || 0,
      countryId: body.countryId != null ? Number(body.countryId) : null,
      valas: Number(body.valas) || 0,
      kurs: Number(body.kurs) || 0,
      cargoPerKg: Number(body.cargoPerKg) || 0,
      profitPct: Number(body.profitPct) || 0,
      operationalFee: Number(body.operationalFee ?? 5000),
      packingFee: Number(body.packingFee ?? 5000),
      cost: Number(body.cost) || 0,
      profitFixed: Number(body.profitFixed) || 0,
    })

    return NextResponse.json({ success: true, id: result.id })
  } catch (err) {
    console.error("Failed to add product:", err)
    return NextResponse.json({ error: "Failed to add product" }, { status: 500 })
  }
}
