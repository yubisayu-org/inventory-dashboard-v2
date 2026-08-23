import { NextRequest, NextResponse } from "next/server"
import { customerFromRequest } from "@/lib/catalogue-bearer"
import { corsHeaders, privateHeaders } from "@/lib/catalogue-cors"
import { getCustomerProfile, updateCustomerProfile } from "@/lib/db/catalogue-profile"
import catalogueSql from "@/lib/db-catalogue-public"

const MAX_BODY_BYTES = 4 * 1024
const MAX_TEXT = 300

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET(req: NextRequest) {
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: privateHeaders() })
  }
  try {
    // Read through the least-privilege role: it can see contact and address
    // columns and cannot see bank details or ongkos_kirim at all.
    const profile = await getCustomerProfile(customer.id, catalogueSql)
    return NextResponse.json({ profile }, { headers: privateHeaders() })
  } catch (err) {
    console.error("Failed to load customer profile:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500, headers: corsHeaders() })
  }
}

export async function PATCH(req: NextRequest) {
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: privateHeaders() })
  }

  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: corsHeaders() })
  }

  let b: Record<string, unknown>
  try {
    b = JSON.parse(raw || "{}")
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() })
  }

  const text = (v: unknown) => String(v ?? "").trim().slice(0, MAX_TEXT)
  const name = text(b.name)
  const whatsapp = text(b.whatsapp)
  const dataDiri = text(b.dataDiri)
  const kota = text(b.kota)
  const kecamatan = text(b.kecamatan)

  if (!name || !whatsapp || !dataDiri || !kota || !kecamatan) {
    return NextResponse.json(
      { error: "Name, WhatsApp, address and area are all required" },
      { status: 400, headers: corsHeaders() },
    )
  }

  try {
    // The customer id comes from the verified session, never the body — this
    // write runs on the main pool and could otherwise edit anyone.
    const { needsReview } = await updateCustomerProfile(customer.id, {
      name,
      whatsapp,
      dataDiri,
      kota,
      kecamatan,
      kodePos: text(b.kodePos),
      biteshipAreaId: b.biteshipAreaId ? text(b.biteshipAreaId) : null,
      biteshipAreaName: b.biteshipAreaName ? text(b.biteshipAreaName) : null,
    })
    return NextResponse.json({ ok: true, needsReview }, { headers: privateHeaders() })
  } catch (err) {
    console.error("Failed to save customer profile:", err)
    return NextResponse.json({ error: "Failed to save" }, { status: 500, headers: corsHeaders() })
  }
}
