import { NextRequest, NextResponse } from "next/server"
import sql from "@/lib/db-pool"
import { searchAreas, BiteshipNotConfiguredError } from "@/lib/biteship"

/**
 * The courier's areas for one district, for the registration form.
 *
 * Public and unauthenticated, like /api/public/register, and billed per call --
 * so it is deliberately a LOOKUP, not a search. The caller may not pass free
 * text: it passes a kabupaten and a kecamatan, and the pair must exist in
 * `jne_rates`, which is the same fixed list the form's dropdowns are built
 * from. A stranger can therefore only ask "what are Biteship's areas for
 * Pondok Aren", 7.000 times over, and never "search the country for X".
 *
 * Why the form needs it at all: Biteship returns ONE AREA PER POSTAL CODE in a
 * district, so this is also the only authoritative list of postal codes that
 * district has. That makes the wrong-postcode case correctable at the moment
 * she types it, instead of arriving as a shipping label pointing at the wrong
 * part of town.
 *
 * Abuse controls: origin-locked (browsers only), a body cap, the fixed-list
 * check above, and the day-long cache in `searchAreas` -- a district asked
 * about twice in a day is billed once.
 */

const ALLOWED_ORIGIN = "https://yubisayu-org.github.io"
const MAX_BODY_BYTES = 1024

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

export async function POST(req: NextRequest) {
  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) return bad("Body too large", 413)

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw || "{}")
  } catch {
    return bad("Invalid JSON")
  }

  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  const kota = str(body.kota)
  const kecamatan = str(body.kecamatan)
  const kodePos = str(body.kode_pos)

  if (!kota || !kecamatan) return bad("kota and kecamatan are required")
  if (kota.length > 80 || kecamatan.length > 80) return bad("Value too long")
  if (kodePos && !/^[0-9]{5}$/.test(kodePos)) return bad("Invalid postal code")

  // The pair must be one the form could actually have offered. This is what
  // keeps a public, billed endpoint from being a general-purpose search.
  const [known] = (await sql`
    SELECT 1 AS ok FROM jne_rates
     WHERE upper(trim(kab_kota_nama)) = upper(${kota})
       AND upper(trim(kecamatan_nama)) = upper(${kecamatan})
     LIMIT 1
  `) as unknown as { ok: number }[]
  if (!known) return bad("Unknown district", 404)

  try {
    const areas = await searchAreas(`${kecamatan}, ${kota}`)

    // Biteship spells districts its own way, so filter on the district it
    // returns rather than trusting the search to have understood us. One area
    // per postal code survives.
    const letters = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "")
    const want = letters(kecamatan)
    const mine = areas.filter((a) => {
      const [kec = ""] = a.name.replace(/\.?\s*\d{5}\s*$/, "").split(",")
      const k = letters(kec)
      return k === want || k.includes(want) || want.includes(k)
    })

    const postalOf = (name: string) => (name.match(/(\d{5})\s*$/) ?? [])[1] ?? ""
    const out = mine.map((a) => ({
      id: a.id,
      name: a.name,
      postal: postalOf(a.name),
    }))
    const exact = kodePos ? out.find((a) => a.postal === kodePos) ?? null : null

    return NextResponse.json(
      {
        areas: out,
        // What the form should do, decided here so the rule lives in one place.
        //   "exact"    her postal is one of the district's -- confirm it
        //   "choose"   it is not -- show her the real ones
        //   "none"     Biteship has no area for this district; submit without
        match: exact ? "exact" : out.length ? "choose" : "none",
        area: exact,
      },
      { headers: { ...corsHeaders(), "Cache-Control": "no-store" } },
    )
  } catch (err) {
    if (err instanceof BiteshipNotConfiguredError) {
      // Registration must not depend on a courier API being up. The form falls
      // back to submitting without an area, and staff picks one later.
      return NextResponse.json(
        { areas: [], match: "none", area: null },
        { headers: { ...corsHeaders(), "Cache-Control": "no-store" } },
      )
    }
    console.error("Biteship area lookup failed:", err)
    return NextResponse.json(
      { areas: [], match: "none", area: null },
      { headers: { ...corsHeaders(), "Cache-Control": "no-store" } },
    )
  }
}
