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
  // Her street, and the legacy string, kept apart on purpose.
  //
  // A catalogue that has not shipped the new field yet sends only `dataDiri`,
  // and what it sends is the whole composed LABEL, not a street. Reading one
  // as the other would store a label in the street column and then compose a
  // second label around it. So the old string travels its old path and the
  // street column is left untouched; only a caller that names `jalan` writes
  // a street.
  const jalan = text(b.jalan)
  const dataDiri = text(b.dataDiri)
  const kota = text(b.kota)
  const kecamatan = text(b.kecamatan)

  // Named, not listed.
  //
  // This used to answer "Name, WhatsApp, address and area are all required" to
  // every one of five different causes, leaving the customer to guess which
  // box was the problem — on a form where all five look filled in, because the
  // empty one is a value she never typed and cannot see. It cost an afternoon
  // to find one of these from the outside.
  //
  // `field` is for us; `error` is for her, and says the one thing she can act
  // on. City and district are not boxes she fills in — they come from the area
  // she picks — so they are described as the area.
  const missing = (
    !name ? { field: "name", error: "Please enter your name." }
      : !whatsapp ? { field: "whatsapp", error: "Please enter your WhatsApp number." }
        : !(jalan || dataDiri) ? { field: "jalan", error: "Please enter your street address." }
          : !kota ? { field: "kota", error: "Please search for and choose your area again." }
            : !kecamatan ? { field: "kecamatan", error: "Please search for and choose your area again." }
              : null
  )
  if (missing) {
    return NextResponse.json(missing, { status: 400, headers: corsHeaders() })
  }

  try {
    // The customer id comes from the verified session, never the body — this
    // write runs on the main pool and could otherwise edit anyone.
    //
    // Once a street arrives the label is composed from the parts and the sent
    // string is dropped: a caller that could write data_diri directly could
    // put anything at all on a parcel.
    const { needsReview } = await updateCustomerProfile(customer.id, {
      name,
      whatsapp,
      ...(jalan
        ? { jalan, provinsi: text(b.provinsi) }
        : { dataDiri }),
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
