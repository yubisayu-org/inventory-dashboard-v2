import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import {
  getOperationalExpensesPaginated,
  getExpenseMethods,
  addOperationalExpense,
  getEvents,
  withActor,
} from "@/lib/db"
import { EXPENSE_CATEGORIES, type ExpenseCategory } from "@/lib/db/types"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const params = req.nextUrl.searchParams

  try {
    // Paginated rows when ?page is present.
    if (params.get("page")) {
      const page = Math.max(1, parseInt(params.get("page")!, 10) || 1)
      const pageSize = Math.min(100, Math.max(1, parseInt(params.get("pageSize") ?? "25", 10)))
      const result = await getOperationalExpensesPaginated({
        page,
        pageSize,
        search: params.get("search") ?? undefined,
        event: params.get("event") ?? undefined,
        category: params.get("category") ?? undefined,
        method: params.get("method") ?? undefined,
        sortKey: params.get("sortKey") ?? undefined,
        sortDir: (params.get("sortDir") as "asc" | "desc") ?? undefined,
        skipCount: params.get("skipCount") === "true",
      })
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } })
    }

    // Otherwise return dropdown meta: events with their currency + kurs (1 event =
    // 1 country drives the expense's default currency/kurs) and the distinct method
    // list (autocomplete). Both are full lists, not derivable from a page.
    const [events, methods] = await Promise.all([getEvents(), getExpenseMethods()])
    return NextResponse.json(
      {
        events: events.map((e) => ({ name: e.name, currency: e.currency, kurs: e.kurs })),
        methods,
      },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (err) {
    console.error("Failed to load operational expenses:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const body = await req.json()
    if (!String(body.event ?? "").trim()) {
      return NextResponse.json({ error: "event is required" }, { status: 400 })
    }
    const category = body.category as ExpenseCategory
    if (!EXPENSE_CATEGORIES.includes(category)) {
      return NextResponse.json({ error: "invalid category" }, { status: 400 })
    }

    const result = await withActor(session.user.email, (tx) => addOperationalExpense({
      event: String(body.event).trim(),
      expenseDate: String(body.expenseDate ?? "").trim(),
      description: String(body.description ?? "").trim(),
      category,
      amountForeign: Number(body.amountForeign) || 0,
      rate: Number(body.rate) || 0,
      amountIdr: Math.round(Number(body.amountIdr) || 0),
      isSettled: Boolean(body.isSettled),
      method: String(body.method ?? "").trim(),
      remarks: String(body.remarks ?? "").trim(),
    }, tx))

    return NextResponse.json({ success: true, id: result.rowNumber })
  } catch (err) {
    console.error("Failed to add operational expense:", err)
    return NextResponse.json({ error: "Failed to add operational expense" }, { status: 500 })
  }
}
