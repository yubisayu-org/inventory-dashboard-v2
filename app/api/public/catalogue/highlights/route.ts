import { NextResponse } from "next/server"
import { getVisibleCatalogueHighlights } from "@/lib/db"
import catalogueSql from "@/lib/db-catalogue-public"

// Public, no-login endpoint listing highlights for the customer-facing
// catalogue site's filter UI (a separate repo/deploy, mirroring how
// yubisayu-invoice.netlify.app consumes /api/public/invoice). Only
// id/name are exposed — default_event is staff-only, see
// getVisibleCatalogueHighlights's own doc comment.
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
    const highlights = await getVisibleCatalogueHighlights(catalogueSql)
    return NextResponse.json(
      { highlights },
      { headers: { ...corsHeaders(), "Cache-Control": "public, max-age=60" } },
    )
  } catch (err) {
    console.error("Failed to fetch catalogue highlights:", err)
    return NextResponse.json(
      { error: "Failed to fetch highlights" },
      { status: 500, headers: corsHeaders() },
    )
  }
}
