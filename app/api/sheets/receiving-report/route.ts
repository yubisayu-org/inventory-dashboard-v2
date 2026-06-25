import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getReceivedReport } from "@/lib/db"

// Current date in the business timezone (Asia/Jakarta), as YYYY-MM-DD. en-CA
// formats as ISO date; the explicit timeZone keeps "today" on the wall clock
// regardless of where the server runs.
function jakartaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date())
}

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireOwner(session)
  if (roleError) return roleError

  const params = req.nextUrl.searchParams
  const fromParam = params.get("from")
  const toParam = params.get("to")
  const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)
  if ((fromParam && !isDate(fromParam)) || (toParam && !isDate(toParam))) {
    return NextResponse.json({ error: "from/to must be YYYY-MM-DD" }, { status: 400 })
  }
  // Default an absent end to the start (and vice versa), then order them so a
  // reversed range still works.
  const today = jakartaToday()
  let from = fromParam ?? toParam ?? today
  let to = toParam ?? fromParam ?? today
  if (from > to) [from, to] = [to, from]

  try {
    const items = await getReceivedReport(from, to)
    const totalUnits = items.reduce((sum, i) => sum + i.unitsReceived, 0)
    return NextResponse.json(
      { from, to, items, totalUnits },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to fetch received report:", err)
    return NextResponse.json({ error: "Failed to fetch received report" }, { status: 500 })
  }
}
