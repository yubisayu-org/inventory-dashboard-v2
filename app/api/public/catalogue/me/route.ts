import { NextRequest, NextResponse } from "next/server"
import { customerFromRequest } from "@/lib/catalogue-bearer"
import { corsHeaders, privateHeaders } from "@/lib/catalogue-cors"

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET(req: NextRequest) {
  try {
    const customer = await customerFromRequest(req)
    if (!customer) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: privateHeaders() })
    }
    return NextResponse.json(
      { customer: { id: customer.id, instagramHandle: customer.instagramId } },
      { headers: privateHeaders() },
    )
  } catch (err) {
    console.error("Failed to resolve catalogue customer:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500, headers: corsHeaders() })
  }
}
