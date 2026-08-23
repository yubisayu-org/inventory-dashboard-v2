import { NextRequest, NextResponse } from "next/server"
import { customerFromRequest } from "@/lib/catalogue-bearer"
import { corsHeaders, privateHeaders } from "@/lib/catalogue-cors"
import {
  listAnnouncementsForCustomer,
  markAnnouncementsRead,
} from "@/lib/db/announcements"
import catalogueSql from "@/lib/db-catalogue-public"

// The signed-in customer's inbox. Announcements go to everyone, so there is
// nothing to scope by — but the read state is theirs, and the customer id
// comes from the verified session rather than the request.

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET(req: NextRequest) {
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: privateHeaders() })
  }
  try {
    const announcements = await listAnnouncementsForCustomer(customer.id, catalogueSql)
    const unread = announcements.filter((a) => !a.read).length
    return NextResponse.json({ announcements, unread }, { headers: privateHeaders() })
  } catch (err) {
    console.error("Failed to load announcements:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500, headers: corsHeaders() })
  }
}

/**
 * Mark the inbox read.
 *
 * Takes no ids: the set the customer just saw is whatever exists now, and
 * accepting ids from the body would let a caller mark rows it was never
 * shown. There is nothing to gain by doing that, but there is nothing to gain
 * by allowing it either.
 */
export async function POST(req: NextRequest) {
  const customer = await customerFromRequest(req)
  if (!customer) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401, headers: privateHeaders() })
  }
  try {
    await markAnnouncementsRead(customer.id, catalogueSql)
    return NextResponse.json({ success: true }, { headers: privateHeaders() })
  } catch (err) {
    console.error("Failed to mark announcements read:", err)
    return NextResponse.json({ error: "Failed to save" }, { status: 500, headers: corsHeaders() })
  }
}
