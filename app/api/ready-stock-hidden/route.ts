import { NextResponse } from "next/server"
import { listHiddenReadyStock } from "@/lib/db/ready-stock"

// Which ready-stock rows customers cannot see, and why. Staff only.
export async function GET() {
  try {
    return NextResponse.json({ hidden: await listHiddenReadyStock() })
  } catch (err) {
    console.error("Failed to list hidden ready stock:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}
