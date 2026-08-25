import { NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { listHiddenReadyStock } from "@/lib/db/ready-stock"

// Which ready-stock rows customers cannot see, and why. Staff only — and now
// actually so: /dashboard/excess-purchase is in ADMIN_ROUTES, so any signed-in
// role may read it, but until this guard existed so could anyone at all.
export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    return NextResponse.json({ hidden: await listHiddenReadyStock() })
  } catch (err) {
    console.error("Failed to list hidden ready stock:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}
