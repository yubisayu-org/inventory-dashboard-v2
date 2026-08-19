import { NextRequest, NextResponse } from "next/server"
import { customerFromRequest } from "@/lib/catalogue-bearer"
import { corsHeaders, privateHeaders } from "@/lib/catalogue-cors"
import { getCustomerOrders, getCustomerBalance } from "@/lib/db/catalogue-orders"
import catalogueSql from "@/lib/db-catalogue-public"

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET(req: NextRequest) {
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: privateHeaders() })
  }
  try {
    // The handle comes from the session; the least-privilege role can reach
    // order columns and the balance view and nothing else.
    const [orders, balance] = await Promise.all([
      getCustomerOrders(customer.instagramId, catalogueSql),
      getCustomerBalance(customer.instagramId, catalogueSql),
    ])
    return NextResponse.json({ orders, balance }, { headers: privateHeaders() })
  } catch (err) {
    console.error("Failed to load customer orders:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500, headers: corsHeaders() })
  }
}
