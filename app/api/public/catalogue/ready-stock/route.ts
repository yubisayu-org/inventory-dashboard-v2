import { NextResponse, NextRequest } from "next/server"
import { customerFromRequest } from "@/lib/catalogue-bearer"
import { corsHeaders, privateHeaders } from "@/lib/catalogue-cors"
import { listReadyStock } from "@/lib/db/ready-stock"
import catalogueSql from "@/lib/db-catalogue-public"

// Stock the shop already owns. Signed in only — the same bar as the rest of
// the account pages, since this is what is actually available to buy rather
// than the public catalogue.

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET(req: NextRequest) {
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: privateHeaders() })
  }
  try {
    return NextResponse.json({ items: await listReadyStock(catalogueSql) }, { headers: privateHeaders() })
  } catch (err) {
    console.error("Failed to load ready stock:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500, headers: corsHeaders() })
  }
}
