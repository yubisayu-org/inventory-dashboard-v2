import { NextRequest, NextResponse } from "next/server"
import { composeLabel } from "@/lib/address"
import { registerCustomer } from "@/lib/db"

// Public, no-login endpoint for the external registration form
// (yubisayu-org.github.io/registration_form). Inserts/updates a row in the
// `customers` table via the privileged server-side connection — the form never
// touches the DB directly (trusted-gateway, same model as /api/public/invoice).
// Not matched by middleware (which only guards /dashboard), so it is
// intentionally reachable without a session.
//
// Abuse controls (CORS is NOT one — it only restrains browsers): Cloudflare
// Turnstile verification, per-field length/format validation, a body-size guard,
// and a backfill-only upsert (registerCustomer) that can't overwrite an existing
// customer's contact data.

const ALLOWED_ORIGIN = "https://yubisayu-org.github.io"
const MAX_BODY_BYTES = 8 * 1024 // generous for this payload; rejects junk floods

// Per-field caps (chars). Reject rather than truncate so bad input is visible.
const LIMITS = {
  instagram: 30, // Instagram max handle length
  nama_depan: 60,
  nama_belakang: 60,
  email: 120,
  ponsel: 20,
  jalan: 300,
  provinsi: 60,
  kota: 80,
  kecamatan: 80,
  kode_pos: 10,
  ekspedisi: 40,
  biteship_area_id: 64,
  biteship_area_name: 160,
} as const

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: corsHeaders() })
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

// Server-side Cloudflare Turnstile check. When TURNSTILE_SECRET_KEY is unset
// (e.g. before keys are provisioned) the check is skipped with a warning so the
// flow keeps working during rollout — set the secret to enforce.
async function verifyTurnstile(token: string, ip: string | null): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) {
    console.warn("TURNSTILE_SECRET_KEY not set — skipping bot check")
    return true
  }
  if (!token) return false
  const form = new URLSearchParams({ secret, response: token })
  if (ip) form.set("remoteip", ip)
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    })
    const data = (await res.json()) as { success?: boolean }
    return data.success === true
  } catch (err) {
    console.error("Turnstile verification request failed:", err)
    return false
  }
}

// Fold the form's structured fields into the single `data_diri` free-text column,
// matching the legacy labeled format (Nama:/Telepon:/Alamat:) so the blob is
// directly usable on printed shipping labels. Phone is duplicated here (also
// stored in the `whatsapp` column) on purpose. Empty fields are skipped.
// Dashboard renders this with `whitespace-pre-line`.
/**
 * The label text for a registration, from the same composer the dashboard uses.
 *
 * It was written here first and copied nowhere, which was fine until the
 * dashboard had to produce the identical string -- two copies of one format is
 * how a customer ends up with two different labels depending on who last
 * touched her row.
 */
function composeDataDiri(b: Record<string, string>): string {
  const label = composeLabel({
    name: [b.nama_depan, b.nama_belakang].filter(Boolean).join(" ").trim(),
    whatsapp: b.ponsel,
    jalan: b.jalan,
    kecamatan: b.kecamatan,
    kota: b.kota,
    provinsi: b.provinsi,
    kodePos: b.kode_pos,
  })
  // The email is the shop's, not the courier's -- it has never been on a label
  // and is kept only because the old blob carried it.
  return b.email ? `${label}\nEmail: ${b.email}` : label
}

export async function POST(req: NextRequest) {
  // Body-size guard (cheap rejection before parsing).
  const declaredLen = Number(req.headers.get("content-length") ?? 0)
  if (declaredLen > MAX_BODY_BYTES) return bad("Payload too large", 413)

  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) return bad("Payload too large", 413)

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    return bad("Invalid JSON body")
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
    // The courier's own id for her address, chosen on the form. Absent when
    // Biteship carries no area for her district or the lookup was down --
    // registration must not depend on a courier API being reachable.
    biteship_area_id: str(body.biteship_area_id),
    biteship_area_name: str(body.biteship_area_name),
  }

  // Bot check first — before any DB work.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
  if (!(await verifyTurnstile(str(body.turnstile_token), ip))) {
    return bad("Failed bot verification", 403)
  }

  // Required + format/length validation. Client-side checks are bypassable, so
  // re-validate here.
  if (!b.instagram) return bad("instagram is required")
  for (const [key, max] of Object.entries(LIMITS)) {
    if ((b as Record<string, string>)[key].length > max) {
      return bad(`${key} is too long (max ${max})`)
    }
  }
  if (!/^@?[a-zA-Z0-9._]{1,30}$/.test(b.instagram)) return bad("Invalid instagram handle")
  if (b.ponsel && !/^[0-9]{6,20}$/.test(b.ponsel)) return bad("Invalid phone number")
  if (b.kode_pos && !/^[0-9]{1,10}$/.test(b.kode_pos)) return bad("Invalid postal code")
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return bad("Invalid email")
  // Biteship's ids look like IDNP9IDNC111IDND268IDZ16512. Reject anything else
  // rather than storing a string that will never match an area.
  if (b.biteship_area_id && !/^[A-Za-z0-9]{8,64}$/.test(b.biteship_area_id)) {
    return bad("Invalid area id")
  }

  try {
    const name = [b.nama_depan, b.nama_belakang].filter(Boolean).join(" ").trim()
    const result = await registerCustomer({
      instagramId: b.instagram,
      name,
      whatsapp: b.ponsel,
      dataDiri: composeDataDiri(b),
      ekspedisi: b.ekspedisi,
      kota: b.kota,
      kecamatan: b.kecamatan,
      kodePos: b.kode_pos,
      jalan: b.jalan,
      provinsi: b.provinsi,
      // Pass null, not undefined, when the form found no area: undefined means
      // "the caller did not say", which registerCustomer reads as "leave the
      // stored area alone". A registration always speaks for the whole address.
      biteshipAreaId: b.biteship_area_id || null,
      biteshipAreaName: b.biteship_area_name || null,
    })
    return NextResponse.json(
      { success: true, id: result.id, created: result.created },
      { headers: { ...corsHeaders(), "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to register customer:", err)
    return bad("Failed to register", 500)
  }
}
