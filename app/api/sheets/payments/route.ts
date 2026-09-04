import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole, isAdmin } from "@/lib/api"
import { getPaymentRows, getPaymentsPaginated, addPayment, findDuplicatePayment, withActor } from "@/lib/db"
import { withServerTiming } from "@/lib/server-timing"

async function handleGET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  const params = req.nextUrl.searchParams

  try {
    // Paginated page of rows when ?page is present (the dashboard table).
    if (params.get("page")) {
      const page = Math.max(1, parseInt(params.get("page")!, 10) || 1)
      const pageSize = Math.min(100, Math.max(1, parseInt(params.get("pageSize") ?? "25", 10)))
      const checkedParam = params.get("isChecked")
      const result = await getPaymentsPaginated({
        page,
        pageSize,
        search: params.get("search") ?? undefined,
        event: params.get("event") ?? undefined,
        customer: params.get("customer") ?? undefined,
        account: params.get("account") ?? undefined,
        remarks: params.get("remarks") ?? undefined,
        kind: params.get("kind") ?? undefined,
        dateFrom: params.get("dateFrom") ?? undefined,
        dateTo: params.get("dateTo") ?? undefined,
        isChecked: checkedParam == null ? undefined : checkedParam === "true",
        rejected: params.get("rejected") == null ? undefined : params.get("rejected") === "true",
        sortKey: params.get("sortKey") ?? undefined,
        sortDir: (params.get("sortDir") as "asc" | "desc") ?? undefined,
        skipCount: params.get("skipCount") === "true",
      })
      // The stat cards are the shop's totals for the filtered period, not the
      // list's. Admins do not get them -- and not merely by not drawing the
      // cards: the numbers must not reach the browser at all, or they are one
      // network tab away. The rows themselves still go, because working this
      // screen means reading them.
      if (isAdmin(session)) {
        const { depositSum: _d, refundSum: _r, filteredSum: _f, ...rest } = result
        return NextResponse.json(rest, { headers: { "Cache-Control": "no-store" } })
      }
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } })
    }

    // Otherwise the full list (back-compat for any non-paginated caller).
    const rows = await getPaymentRows()
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch payments:", err)
    return NextResponse.json({ error: "Failed to fetch payments" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError

  const roleError = requireRole(session)
  if (roleError) return roleError

  try {
    const body = await req.json()
    const { event, customer, amount, account, isChecked, payDate, remarks } = body

    if (!event || !customer) {
      return NextResponse.json({ error: "event and customer are required" }, { status: 400 })
    }

    // The same money written down twice is the mistake this catches, and the
    // caller comes back with force once a person has looked at what it found.
    // Never a refusal: two identical transfers days apart are real, and only
    // the bank statement settles which this is.
    if (!body.force) {
      const duplicate = await findDuplicatePayment({
        customer: String(customer),
        event: String(event),
        amount: Number(amount ?? 0),
        payDate: String(payDate ?? "") || null,
      })
      if (duplicate) {
        return NextResponse.json({ duplicate }, { status: 409 })
      }
    }

    const result = await withActor(session.user.email, (tx) => addPayment({
      event: String(event),
      customer: String(customer),
      amount: Number(amount ?? 0),
      account: String(account ?? ""),
      // Admins cannot confirm payments — new payments are always unchecked.
      isChecked: isAdmin(session) ? false : Boolean(isChecked),
      payDate: String(payDate ?? ""),
      remarks: String(remarks ?? ""),
    }, tx))

    return NextResponse.json({ success: true, rowNumber: result.rowNumber })
  } catch (err) {
    console.error("Failed to add payment:", err)
    return NextResponse.json({ error: "Failed to add payment" }, { status: 500 })
  }
}

// Timed: the response carries Server-Timing (total / db / dbmax / app).
// See lib/server-timing.ts for how to read it.
export const GET = withServerTiming(handleGET)
