import { NextResponse } from "next/server"
import catalogueSql from "@/lib/db-catalogue-public"

// Public, no-login endpoint listing countries for the custom-request price
// estimator's country picker. Only id/name — kurs/cargo_per_kg are never
// exposed here (see estimate-price/route.ts, which uses them server-side
// only). See docs/superpowers/specs/2026-08-16-custom-request-price-estimate-design.md.
//
// TODO: swap for the real domain once the catalogue site is deployed.
const ALLOWED_ORIGIN = "https://yubisayu-catalogue.netlify.app"

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET() {
  try {
    const rows = await catalogueSql`SELECT id, name FROM countries ORDER BY name`
    const countries = rows.map((r) => ({ id: r.id as number, name: r.name as string }))
    return NextResponse.json(
      { countries },
      { headers: { ...corsHeaders(), "Cache-Control": "public, max-age=60" } },
    )
  } catch (err) {
    console.error("Failed to load countries:", err)
    return NextResponse.json(
      { error: "Failed to load countries" },
      { status: 500, headers: corsHeaders() },
    )
  }
}
