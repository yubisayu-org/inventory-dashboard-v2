import { NextRequest, NextResponse } from "next/server"
import { lookupOngkir, registerCustomer } from "@/lib/db"

// Public, no-login endpoint for the external registration form
// (yubisayu-org.github.io/registration_form). Inserts/updates a row in the
// `customers` table via the privileged server-side connection — the form never
// touches the DB directly (trusted-gateway, same model as /api/public/invoice).
// Not matched by middleware (which only guards /dashboard), so it is
// intentionally reachable without a session.

const ALLOWED_ORIGIN = "https://yubisayu-org.github.io"

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

// Fold the form's structured fields into the single `data_diri` free-text column
// (phone is stored separately in `whatsapp`). Multi-line; the dashboard renders
// it with `whitespace-pre-line`.
function composeDataDiri(b: Record<string, string>): string {
  const name = [b.nama_depan, b.nama_belakang].filter(Boolean).join(" ").trim()
  const region = [b.kecamatan, b.kota, b.provinsi].filter(Boolean).join(", ")
  const regionLine = [region, b.kode_pos].filter(Boolean).join(" ").trim()
  const lines = [name, b.jalan, regionLine]
  if (b.email) lines.push(`Email: ${b.email}`)
  return lines.filter(Boolean).join("\n")
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() })
  }

  const str = (v: unknown) => String(v ?? "").trim()
  const b = {
    instagram: str(body.instagram),
    nama_depan: str(body.nama_depan),
    nama_belakang: str(body.nama_belakang),
    email: str(body.email),
    ponsel: str(body.ponsel),
    jalan: str(body.jalan),
    provinsi: str(body.provinsi),
    kota: str(body.kota),
    kecamatan: str(body.kecamatan),
    kode_pos: str(body.kode_pos),
    ekspedisi: str(body.ekspedisi),
  }

  if (!b.instagram) {
    return NextResponse.json({ error: "instagram is required" }, { status: 400, headers: corsHeaders() })
  }

  try {
    const ongkosKirim = await lookupOngkir(b.kota, b.kecamatan)
    const result = await registerCustomer({
      instagramId: b.instagram,
      whatsapp: b.ponsel,
      dataDiri: composeDataDiri(b),
      ekspedisi: b.ekspedisi,
      ongkosKirim,
    })
    return NextResponse.json(
      { success: true, id: result.id, updated: result.updated },
      { headers: { ...corsHeaders(), "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to register customer:", err)
    return NextResponse.json({ error: "Failed to register" }, { status: 500, headers: corsHeaders() })
  }
}
