"use client"

import { displayIg } from "@/lib/format"
import TableSkeleton from "@/components/TableSkeleton"
import DataGrid, { type ColumnDef } from "@/components/DataGrid"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { InvoiceEvent, InvoiceOrderLine, InvoiceResult, RefundRow, RefundReason, RefundStatus, OverpaymentToCheck, OutstandingTrip } from "@/lib/db"
import { normalizeId } from "@/lib/db/helpers"
import { isCreditPromised } from "@/lib/db/refund-credit"
import { isLiveAmount } from "@/lib/db/live-refund"
import { REFUND_REASONS } from "@/lib/db/types"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { useHitAndRun, handleKey } from "@/hooks/useHitAndRun"
import { HitAndRunFlag } from "@/components/HitAndRunFlag"
import { fetchJson } from "@/lib/api-fetch"
import EventSelect from "@/components/EventSelect"
import SearchableSelect from "@/components/SearchableSelect"
import { InvoiceDetailDrawer } from "@/app/dashboard/invoice/InvoiceDetailDrawer"
import { useMessageTemplates } from "@/hooks/useMessageTemplates"
import { useCustomerWhatsApp } from "@/hooks/useCustomerWhatsApp"
import { MessageButton } from "@/components/MessageButton"
import { fillTemplate, DEFAULT_TEMPLATES } from "@/lib/message-templates"
import {
  causeLineFor, fillNotice, REFUND_CAUSES, MANUAL_REFUND_CAUSES, NOTICE_TEMPLATES,
} from "@/lib/notice-templates"

const INPUT_CLASS =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

const REASON_LABELS: Record<string, string> = {
  overpayment: "Overpayment",
  unavailable: "Item Unavailable",
  shipping_loss: "Lost in Shipping",
  damaged: "Damaged",
  wrong_item: "Wrong Item",
  customer_cancelled: "Customer Cancelled",
  goodwill: "Goodwill",
  quality: "Quality",
  other: "Other",
}

// Any reason outside the known presets is a user-typed value — show it as-is.
const reasonLabel = (reason: RefundReason) => REASON_LABELS[reason] ?? reason
const toReasonOptions = (reasons: string[]) =>
  Array.from(new Set([...REFUND_REASONS, ...reasons])).map((r) => ({ value: r, label: REASON_LABELS[r] ?? r }))

const STATUS_LABELS: Record<RefundStatus, string> = {
  pending: "Pending",
  awaiting_bank_info: "Bank Info",
  ready_to_refund: "Transfer",
  refunded: "Refunded",
  applied_to_next_order: "Applied to Next Order",
  cancelled: "Cancelled",
}

const STATUS_COLORS: Record<RefundStatus, string> = {
  pending: "bg-yellow-50 text-yellow-700 border-yellow-200",
  awaiting_bank_info: "bg-blue-50 text-blue-700 border-blue-200",
  ready_to_refund: "bg-orange-50 text-orange-700 border-orange-200",
  refunded: "bg-green-50 text-green-700 border-green-200",
  applied_to_next_order: "bg-purple-50 text-purple-700 border-purple-200",
  cancelled: "bg-surface-muted text-muted border-cream-border",
}

/** Not a refund status — a list of money owed that nobody has decided about. */
const TO_CHECK = "to_check" as const
type TabKey = RefundStatus | typeof TO_CHECK

const ACTIVE_TABS: { key: TabKey; label: string }[] = [
  { key: TO_CHECK, label: "To check" },
  { key: "pending", label: "Pending" },
  { key: "awaiting_bank_info", label: "Bank Info" },
  { key: "ready_to_refund", label: "Transfer" },
  { key: "refunded", label: "Done" },
]

/**
 * Money a customer is owed that no refund covers yet.
 *
 * Deliberately not the Pending grid. Pending is a to-do list — every row in it
 * is money you have decided to send — and a Rp 2.000 shipping rounding is not a
 * task. Put it there and you learn to skim the one list that must not be
 * skimmed. Here it is an observation until you say otherwise.
 */
function ToCheckPanel({ rows, error, promoting, onPromote, onRetry, search, onSearchChange }: {
  rows: OverpaymentToCheck[] | null
  error: string
  promoting: string
  onPromote: (row: OverpaymentToCheck) => void
  onRetry: () => void
  search: string
  onSearchChange: (value: string) => void
}) {
  const columns = useMemo<ColumnDef<OverpaymentToCheck, unknown>[]>(() => [
    {
      accessorKey: "customer",
      header: "Customer",
      size: 180,
      filterFn: "textContains",
      cell: ({ getValue }) => (
        <span className="font-medium text-foreground">{displayIg(getValue<string>())}</span>
      ),
    },
    {
      accessorKey: "event",
      header: "Event",
      size: 130,
      filterFn: "textContains",
      cell: ({ getValue }) => <span className="text-muted-strong">{getValue<string>()}</span>,
    },
    // Paid and invoiced sit beside the gap so a small difference can be
    // recognised as rounding without opening the invoice.
    {
      accessorKey: "totalPaid",
      header: "Paid",
      size: 130,
      filterFn: "numeric",
      meta: { align: "right" },
      cell: ({ getValue }) => (
        <span className="tabular-nums text-muted">{formatRp(getValue<number>())}</span>
      ),
    },
    {
      accessorKey: "invoiceTotal",
      header: "Invoiced",
      size: 130,
      filterFn: "numeric",
      meta: { align: "right" },
      cell: ({ getValue }) => (
        <span className="tabular-nums text-muted">{formatRp(getValue<number>())}</span>
      ),
    },
    {
      accessorKey: "uncovered",
      header: "Uncovered",
      size: 140,
      filterFn: "numeric",
      meta: { align: "right" },
      cell: ({ row }) => (
        <div className="flex flex-col items-end">
          <span className="tabular-nums font-semibold text-brand">{formatRp(row.original.uncovered)}</span>
          {/* What a mark has already covered, where the gap is only what is
              left of it — otherwise the figure reads as the whole overpayment. */}
          {row.original.refundedSoFar > 0 && (
            <span className="text-[11px] text-faint tabular-nums">
              after {formatRp(row.original.refundedSoFar)} refunded
            </span>
          )}
        </div>
      ),
    },
    {
      id: "action",
      header: "",
      size: 140,
      enableSorting: false,
      enableColumnFilter: false,
      meta: { align: "right" },
      cell: ({ row }) => {
        const r = row.original
        const busy = promoting === `${r.event}|${r.customer}`
        return (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onPromote(r) }}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-bold disabled:opacity-50 whitespace-nowrap"
          >
            {busy ? "Creating…" : "Create refund"}
          </button>
        )
      },
    },
  ], [promoting, onPromote])

  const renderMobileCard = useCallback((r: OverpaymentToCheck) => {
    const busy = promoting === `${r.event}|${r.customer}`
    return (
      <div className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{r.event}</span>
            <span className="text-xs text-faint uppercase truncate">{displayIg(r.customer)}</span>
          </div>
          <div className="mt-0.5 text-xs text-muted tabular-nums">
            paid {formatRp(r.totalPaid)} of {formatRp(r.invoiceTotal)}
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1.5">
          <span className="text-sm font-semibold tabular-nums text-brand">{formatRp(r.uncovered)}</span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onPromote(r) }}
            disabled={busy}
            className="px-2.5 py-1 rounded-lg bg-brand text-white text-[11px] font-bold disabled:opacity-50 whitespace-nowrap"
          >
            {busy ? "Creating…" : "Create refund"}
          </button>
        </div>
      </div>
    )
  }, [promoting, onPromote])

  if (error) {
    return (
      <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex items-center justify-between gap-3">
        <span>{error}</span>
        <button onClick={onRetry} className="text-xs px-3 py-1.5 rounded-lg border border-red-300 text-red-700 hover:bg-red-100 shrink-0">
          Retry
        </button>
      </div>
    )
  }
  if (rows === null) return <div className="mt-3"><TableSkeleton /></div>
  if (rows.length === 0) {
    return (
      <div className="mt-3 rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-faint">
        No overpayments to check.
      </div>
    )
  }

  // The same mt-3 the pending grid sits in, so switching tabs does not nudge
  // the table up or down.
  return (
    <div className="mt-3">
    <DataGrid
      data={rows}
      columns={columns}
      pageSize={25}
      searchPlaceholder="Search customer or event…"
      searchValue={search}
      onSearchChange={onSearchChange}
      fullWidthSearch
      tightToolbar
      boldUppercaseHeader
      hideRowCount
      getRowId={(r) => `${r.event}|${r.customer}`}
      renderMobileCard={renderMobileCard}
      paginationVariant="simple"
      // Largest first, because that is the order they get worked.
      initialSorting={[{ id: "uncovered", desc: true }]}
    />
    </div>
  )
}

function formatRp(n: number) {
  return `Rp ${new Intl.NumberFormat("id-ID").format(n)}`
}

// A refund with a partial credit applied still has a real remaining amount
// owed back — that (refundAmount) is what should be shown everywhere. Only
// once it's fully consumed as credit (refundAmount hits 0) does the historical
// "applied as credit" figure become the more meaningful number to display.
function isFullyAppliedAsCredit(row: RefundRow): boolean {
  return row.refundAmount <= 0 && row.appliedCreditAmount > 0
}
function displayAmount(row: RefundRow): number {
  return isFullyAppliedAsCredit(row) ? row.appliedCreditAmount : row.refundAmount
}

/**
 * A row that stands for several refunds.
 *
 * One trip can owe her three separate things, and each stays its own refund
 * because each is its own explanation. On screen that reads as three lines for
 * one person, three times over, and the shape of what is owed disappears into
 * the list. So a customer with more than one open refund on a trip collapses to
 * a line that carries the total, opening to the reasons underneath.
 *
 * The parent is a real member wearing the group's figures -- same event, same
 * customer, so every column that reads those still reads correctly. `reason`
 * carries every member's label so searching "damaged" still finds a collapsed
 * group; the cell renders the count instead.
 */
type GroupRow = RefundRow & { members?: RefundRow[] }

/** Still owed: not paid, not cancelled, and not a deposit she chose to keep. */
function isOpenRefund(r: RefundRow): boolean {
  return (r.status === "pending" || r.status === "awaiting_bank_info" || r.status === "ready_to_refund")
    && displayAmount(r) > 0
}

const pairKey = (r: RefundRow) => `${r.event}|${normalizeId(r.customer)}`

// "Applied to Next Order" claims something that has not happened yet. The
// promise gets its own words and the purple the credit action already uses.
function statusLabel(row: RefundRow): string {
  return isCreditPromised(row) ? "Credit Promised" : STATUS_LABELS[row.status]
}
function statusColor(row: RefundRow): string {
  return isCreditPromised(row) ? "bg-purple-50 text-purple-700 border-purple-200" : STATUS_COLORS[row.status]
}

// ─── Main component ──────────────────────────────────────────────────────────

const CREDIT_PANEL_ID = "refund-credit-panel"

export default function RefundsClient() {
  const options = useSheetOptions()
  const [rows, setRows] = useState<RefundRow[]>([])
  const [dbReasons, setDbReasons] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [tab, setTab] = useState<TabKey>("pending")
  const [toCheck, setToCheck] = useState<OverpaymentToCheck[] | null>(null)
  const [toCheckError, setToCheckError] = useState("")
  const [promoting, setPromoting] = useState("")
  const [creating, setCreating] = useState(false)
  const [mobileCreating, setMobileCreating] = useState(false)
  const [editRow, setEditRow] = useState<RefundRow | null>(null)
  /** Everything one customer is owed on one trip, open in the group sheet. */
  const [groupSheet, setGroupSheet] = useState<RefundRow[] | null>(null)
  const [eventFilter, setEventFilter] = useState("")
  // Owned here rather than by each grid: the tabs swap the data underneath and
  // remount the table, which would drop whatever was typed. Looking for one
  // customer usually means looking for them on more than one tab.
  const [search, setSearch] = useState("")

  const reasonOptions = useMemo(() => toReasonOptions(dbReasons), [dbReasons])

  const fetchRows = useCallback((forceScan = false) => {
    setLoading(true)
    setError("")
    const params = new URLSearchParams()
    // GET /refunds auto-materializes overpayment refunds server-side (throttled).
    // Refresh passes forceScan=1 to run the detection immediately regardless of
    // the throttle window; normal opens reuse the throttled result. Event/search
    // filtering is done client-side by the DataGrid, so we always load all rows.
    if (forceScan) params.set("forceScan", "1")
    fetchJson<{ rows: RefundRow[]; reasons: string[] }>(`/api/sheets/refunds?${params}`)
      .then((data) => { setRows(data.rows ?? []); setDbReasons(data.reasons ?? []) })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { fetchRows() }, [fetchRows])

  // Fetched on first sight of the tab rather than with the page: it is a second
  // pass over every invoice, and most visits never open it.
  const fetchToCheck = useCallback(() => {
    setToCheckError("")
    fetchJson<{ rows: OverpaymentToCheck[] }>("/api/sheets/overpayments")
      .then((data) => setToCheck(data.rows ?? []))
      .catch((err) => setToCheckError(err instanceof Error ? err.message : "Failed to load"))
  }, [])

  useEffect(() => {
    if (tab === TO_CHECK && toCheck === null) fetchToCheck()
  }, [tab, toCheck, fetchToCheck])

  // Every customer's debts on other trips, keyed by normalized handle. One call
  // for the page: a refund is per trip, so a row cannot see that the same person
  // still owes on another one, and nobody thinks to look.
  const [owesElsewhere, setOwesElsewhere] = useState<Record<string, OutstandingTrip[]>>({})

  useEffect(() => {
    // Silent on failure — the chip is a hint. Losing it must not break the page.
    fetchJson<{ byCustomer: Record<string, OutstandingTrip[]> }>("/api/sheets/refunds/outstanding")
      .then((data) => setOwesElsewhere(data.byCustomer ?? {}))
      .catch(() => {})
  }, [])

  /** That customer's other trips with money still owed on them. */
  const outstandingFor = useCallback(
    (customer: string, event: string): OutstandingTrip[] =>
      (owesElsewhere[normalizeId(customer)] ?? []).filter((t) => t.event !== event),
    [owesElsewhere],
  )

  /** Promote one row to a refund. The server recomputes the amount. */
  async function promote(row: OverpaymentToCheck) {
    const key = `${row.event}|${row.customer}`
    setPromoting(key)
    setToCheckError("")
    try {
      const res = await fetch("/api/sheets/overpayments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: row.event, customer: row.customer }),
      })
      // A route that dies returns no body; parsing it reports a JSON error
      // instead of the failure.
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `Failed to create refund (${res.status})`)
      setToCheck((prev) => (prev ?? []).filter((r) => `${r.event}|${r.customer}` !== key))
      fetchRows()
    } catch (err) {
      setToCheckError(err instanceof Error ? err.message : "Failed to create refund")
    } finally {
      setPromoting("")
    }
  }

  const doneStatuses: RefundStatus[] = ["refunded", "applied_to_next_order", "cancelled"]

  // Tabs pre-filter by status stage; the DataGrid then does search / per-column
  // sort & filter over the resulting set.
  const tabFiltered = useMemo(() => {
    return rows.filter((r) =>
      (tab === "refunded"
        ? doneStatuses.includes(r.status) && !isCreditPromised(r)
        : tab === "pending"
          // A promised credit is money still owed, so it belongs with the rest
          // of what is owed rather than filed away as settled.
          ? r.status === "pending" || isCreditPromised(r)
          : r.status === tab) &&
      (!eventFilter || r.event === eventFilter),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, tab, eventFilter])

  /**
   * Collapse within the tab, never across it: a tab is a step, and moving rows
   * between steps to make a tidier group would make the tab lie about what it
   * shows. A customer with a single refund here stays exactly the row she is
   * today, caret and all -- so the flat scan survives for the common case.
   *
   * The Done tab is history and stays flat: nothing there is waiting to be
   * paid, so there is nothing to pay together.
   */
  const tabGrouped = useMemo<GroupRow[]>(() => {
    if (tab === "refunded") return tabFiltered
    const by = new Map<string, RefundRow[]>()
    for (const r of tabFiltered) {
      const k = pairKey(r)
      const list = by.get(k)
      if (list) list.push(r)
      else by.set(k, [r])
    }
    const out: GroupRow[] = []
    for (const list of by.values()) {
      if (list.length < 2) { out.push(list[0]); continue }
      const members = [...list].sort((a, b) => displayAmount(b) - displayAmount(a))
      out.push({
        ...members[0],
        refundAmount: members.reduce((n, m) => n + displayAmount(m), 0),
        appliedCreditAmount: 0,
        reason: members.map((m) => reasonLabel(m.reason)).join(", "),
        members,
      })
    }
    return out
  }, [tabFiltered, tab])

  /**
   * Everything else she is still owed on that trip, wherever it sits.
   *
   * The steps mean something -- Sent is "I asked her for her account", Bank Info
   * is "she replied" -- so they keep their own tabs. What she is owed does not
   * care: one transfer settles all of it, and a refund two tabs away is exactly
   * the one that gets forgotten.
   */
  const openSiblings = useCallback(
    (row: GroupRow): RefundRow[] => {
      const mine = new Set((row.members ?? [row]).map((m) => m.id))
      return rows.filter((r) => !mine.has(r.id) && pairKey(r) === pairKey(row) && isOpenRefund(r))
    },
    [rows],
  )

  const counts = useMemo(() => {
    const c: Partial<Record<RefundStatus | "done", number>> = {}
    for (const r of rows) {
      const key = isCreditPromised(r) ? "pending" : r.status
      c[key] = (c[key] ?? 0) + 1
    }
    const done = (c.refunded ?? 0) + (c.applied_to_next_order ?? 0) + (c.cancelled ?? 0)
    return { ...c, done }
  }, [rows])

  const columns = useMemo<ColumnDef<RefundRow, unknown>[]>(() => [
    {
      // Event first, as the Invoice page reads: the trip is what a row belongs
      // to, and the caret sits beside it. Customer follows, which is what you
      // scan within a trip.
      accessorKey: "event",
      header: "Event",
      size: 130,
      filterFn: "textContains",
      cell: ({ getValue }) => <span className="text-muted whitespace-nowrap">{getValue<string>()}</span>,
    },
    {
      accessorKey: "customer",
      header: "Customer",
      size: 160,
      filterFn: "textContains",
      cell: ({ row }) => {
        const r = row.original
        const owes = outstandingFor(r.customer, r.event)
        const owesTotal = owes.reduce((sum, t) => sum + t.amount, 0)
        return (
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            {displayIg(r.customer)}
            {/* Owed here, behind there. A marker rather than a figure: the
                amount belongs to another trip, and printing it beside this
                row's own amount invites reading the wrong one. Purple is the
                credit colour it leads to. */}
            {owes.length > 0 && (
              <span
                title={`Owes elsewhere — ${owes.map((t) => `${formatRp(t.amount)} on ${t.event}`).join(", ")}`}
                aria-label={`Owes ${formatRp(owesTotal)} on ${owes.length === 1 ? owes[0].event : `${owes.length} other trips`}`}
                className="text-purple-400 shrink-0"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3 4 7l4 4" /><path d="M4 7h16" /><path d="m16 21 4-4-4-4" /><path d="M20 17H4" />
                </svg>
              </span>
            )}
          </div>
        )
      },
    },
    {
      id: "reason",
      // Every member's label, so a search for one reason still finds the group
      // it is folded into. The cell shows the count instead.
      accessorFn: (r) => reasonLabel(r.reason),
      header: "Reason",
      // Wide, because this is the column with sentences in it: expanded members
      // print "Muji Boston Bag 38L Greige × 2 × Rp 100.000" here, one item per
      // line, and a wrapped item name reads as two items.
      size: 360,
      filterFn: "textContains",
      cell: ({ row, getValue }) => {
        const members = (row.original as GroupRow).members
        return members
          ? <span className="font-medium text-foreground">{members.length} refunds</span>
          : <span className="text-muted-strong">{getValue<string>()}</span>
      },
    },
    {
      id: "amount",
      accessorFn: (r) => displayAmount(r),
      header: "Amount",
      size: 130,
      filterFn: "numeric",
      meta: { align: "right" },
      cell: ({ getValue }) => (
        <span className="tabular-nums font-semibold text-foreground">{formatRp(getValue<number>())}</span>
      ),
    },
    {
      id: "status",
      accessorFn: (r) => statusLabel(r),
      header: "Status",
      size: 140,
      filterFn: "textContains",
      cell: ({ row }) => {
        const members = (row.original as GroupRow).members
        if (!members) return (
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${statusColor(row.original)}`}>
            {statusLabel(row.original)}
          </span>
        )
        // One chip per step present, counted -- the group's own status is the
        // spread of its members', and naming only the first would hide the rest.
        const seen = new Map<string, { label: string; cls: string; n: number }>()
        for (const m of members) {
          const label = statusLabel(m)
          const cur = seen.get(label)
          if (cur) cur.n += 1
          else seen.set(label, { label, cls: statusColor(m), n: 1 })
        }
        return (
          <span className="flex flex-wrap gap-1">
            {[...seen.values()].map((c) => (
              <span key={c.label} className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${c.cls}`}>
                {c.n > 1 ? `${c.n} × ` : ""}{c.label}
              </span>
            ))}
          </span>
        )
      },
    },
    {
      id: "pay",
      header: "",
      size: 90,
      enableSorting: false,
      enableColumnFilter: false,
      meta: { align: "right" },
      cell: ({ row }) => {
        const r = row.original as GroupRow
        const all = [...(r.members ?? [r]), ...openSiblings(r)].filter(isOpenRefund)
        if (all.length < 2) return null
        return (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setGroupSheet(all) }}
            className="px-2 py-1 rounded-lg border border-brand text-brand text-xs font-semibold hover:bg-brand-light whitespace-nowrap"
          >
            Pay all ({all.length})
          </button>
        )
      },
    },
    {
      // Hidden by default — exists only so the Done tab can sort by completion
      // time (updatedAt = when the refund reached its terminal status).
      accessorKey: "updatedAt",
      header: "Updated",
      enableColumnFilter: false,
    },
  ], [outstandingFor, openSiblings])

  const renderMobileCard = useCallback((r: GroupRow) => {
    return (
      <div className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{r.event}</span>
            <span className="text-xs text-faint uppercase truncate">{displayIg(r.customer)}</span>
          </div>
          {r.members && (
            <div className="text-xs text-muted mt-0.5">{r.members.length} refunds · one transfer</div>
          )}
        </div>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{formatRp(displayAmount(r))}</span>
      </div>
    )
  }, [])

  function handleUpdated(updated: RefundRow) {
    setRows((prev) => prev.map((r) => r.id === updated.id ? updated : r))
    setEditRow(null)
  }

  function handleCreated() {
    // Reloaded rather than pushed on: the refund is written by the notice
    // path, which answers with an id, and the row it made is the truth.
    fetchRows()
    setTab("pending")
  }

  function handleDeleted(id: number) {
    setRows((prev) => prev.filter((r) => r.id !== id))
    setEditRow(null)
  }

  if (loading) return <TableSkeleton />
  if (error) {
    return (
      <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-red-500">
        {error}
      </div>
    )
  }

  return (
    <>
      {/* Tabs */}
      <div className="flex items-center gap-1 w-full rounded-xl border border-cream-border bg-white p-1 overflow-x-auto">
        {ACTIVE_TABS.map(({ key, label }) => {
          const count = key === TO_CHECK
            ? toCheck?.length
            : key === "refunded" ? counts.done : counts[key as RefundStatus]
          const active = tab === key
            || (key === "refunded" && tab !== TO_CHECK && doneStatuses.includes(tab as RefundStatus))
          return (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex-1 shrink-0 flex items-center justify-center gap-1 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                active
                  ? "bg-brand text-white"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {label}
              {count ? (
                <span className={`hidden sm:inline text-xs rounded-full px-1.5 py-0.5 tabular-nums ${active ? "bg-white/20 text-white" : "bg-surface-sunken text-muted"}`}>
                  {count}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      {tab === TO_CHECK ? (
        <ToCheckPanel
          rows={toCheck}
          error={toCheckError}
          promoting={promoting}
          onPromote={promote}
          onRetry={fetchToCheck}
          search={search}
          onSearchChange={setSearch}
        />
      ) : (
      <div className="mt-3">
        <DataGrid
          key={tab}
          data={tabGrouped}
          columns={columns}
          pageSize={25}
          searchPlaceholder="Search customer or event…"
          searchValue={search}
          onSearchChange={setSearch}
          fullWidthSearch
          tightToolbar
          boldUppercaseHeader
          toolbarExtraAfterColumns
          hideRowCount
          getRowId={(row) => String(row.id)}
          // A group opens the group sheet: her account, her message and the
          // transfer are the customer's, not any one refund's. The caret still
          // opens the list in place, for reading without acting.
          onRowClick={(row) => {
            const g = row as GroupRow
            if (!g.members) { setEditRow(row); return }
            setGroupSheet([...g.members, ...openSiblings(g)].filter(isOpenRefund))
          }}
          canExpandRow={(row) => Boolean((row as GroupRow).members)}
          // Laid out on the header's own measured widths, so a member's reason
          // sits under Reason and its amount under Amount. A detail row that
          // lays itself out lands wherever, and reads as a different table
          // wedged under this one.
          renderExpandedRow={(row, layout) => {
            const members = (row as GroupRow).members
            if (!members) return null
            return (
              <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
                <colgroup>
                  {layout.columnIds.map((id, i) => (
                    <col key={id} style={{ width: layout.widths[i] ? `${layout.widths[i]}px` : undefined }} />
                  ))}
                </colgroup>
                <tbody>
                  {members.map((m) => (
                    <tr
                      key={m.id}
                      onClick={() => setEditRow(m)}
                      className="cursor-pointer hover:bg-white/70 transition-colors"
                    >
                      {layout.columnIds.map((id) => {
                        // Repeated on every member, quieter than the parent's.
                        // A detail row read on its own -- scrolled to, copied
                        // out, pointed at on a screen -- should still say whose
                        // it is and which trip, rather than depending on a line
                        // that may be off the top of the screen.
                        if (id === "customer") return (
                          <td key={id} className="px-4 py-2 align-top text-muted truncate">{displayIg(m.customer)}</td>
                        )
                        if (id === "event") return (
                          <td key={id} className="px-4 py-2 align-top text-faint truncate">{m.event}</td>
                        )
                        // What it is actually about. A mark writes the item and
                        // the count into the note as it goes -- "Akachan Baby
                        // Lotion 300ml × 1", one line per item where several
                        // marks merged into the same refund -- and that is the
                        // thing worth opening a group to read. The reason alone
                        // says a kind of thing went wrong, not which.
                        if (id === "reason") return (
                          <td key={id} className="px-4 py-2 align-top">
                            <div className="text-muted-strong">{reasonLabel(m.reason)}</div>
                            {m.note.split("\n").map((l) => l.trim()).filter(Boolean).map((l, i) => (
                              <div key={i} title={l} className="text-xs text-faint leading-snug truncate">{l}</div>
                            ))}
                          </td>
                        )
                        if (id === "amount") return (
                          <td key={id} className="px-4 py-2 align-top text-right tabular-nums font-semibold text-foreground">
                            {formatRp(displayAmount(m))}
                          </td>
                        )
                        if (id === "status") return (
                          <td key={id} className="px-4 py-2 align-top">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${statusColor(m)}`}>
                              {statusLabel(m)}
                            </span>
                          </td>
                        )
                        return <td key={id} className="px-4 py-2 align-top" />
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }}
          renderMobileCard={renderMobileCard}
          paginationVariant="simple"
          initialVisibility={{ updatedAt: false }}
          // Done tab sorts by completion time (newest first); other tabs by
          // amount. key={tab} remounts so this re-seeds on tab change.
          initialSorting={tab === "refunded" ? [{ id: "updatedAt", desc: true }] : [{ id: "amount", desc: true }]}
          belowToolbar={
            creating ? (
              <div className="hidden md:block">
                <CreateRefundCard
                  events={options?.events ?? []}
                  customers={options?.customers ?? []}
                  customerMobiles={options?.customerMobiles}
                  reasonOptions={reasonOptions}
                  onCreated={handleCreated}
                  onClose={() => setCreating(false)}
                />
              </div>
            ) : undefined
          }
          toolbarExtra={
            <>
              <div className="md:hidden w-40 shrink-0">
                <EventSelect
                  value={eventFilter}
                  onChange={setEventFilter}
                  events={options?.events ?? []}
                  placeholder="All event"
                  clearable
                />
              </div>
              <button
                onClick={() => setCreating((o) => !o)}
                className={`hidden md:inline-flex items-center gap-1.5 h-[38px] px-4 text-sm rounded-lg border transition-colors ${
                  creating ? "bg-brand-light text-brand border-brand/30" : "bg-brand text-white border-transparent hover:bg-brand-dark"
                }`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                New Refund
              </button>
            </>
          }
        />
      </div>
      )}

      {/* Mobile add FAB */}
      <button
        type="button"
        onClick={() => setMobileCreating(true)}
        aria-label="New refund"
        className="md:hidden fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90"
      >
        +
      </button>

      {/* Mobile add sheet */}
      {mobileCreating && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40 flex flex-col justify-end" onClick={() => setMobileCreating(false)}>
          <div className="max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <CreateRefundCard
              events={options?.events ?? []}
              customers={options?.customers ?? []}
              customerMobiles={options?.customerMobiles}
              reasonOptions={reasonOptions}
              onCreated={() => { handleCreated(); setMobileCreating(false); window.scrollTo({ top: 0, behavior: "smooth" }) }}
              onClose={() => setMobileCreating(false)}
            />
          </div>
        </div>
      )}

      {groupSheet && (
        <RefundGroupSheet
          refunds={groupSheet}
          accounts={options?.accounts ?? []}
          onClose={() => setGroupSheet(null)}
          onChanged={() => { setGroupSheet(null); fetchRows() }}
          // The things that really are one refund's own -- its note, its
          // credit, cancelling it -- stay in its own sheet.
          onOpenOne={(r) => { setGroupSheet(null); setEditRow(r) }}
        />
      )}

      {editRow && (
        <RefundDetailModal
          row={editRow}
          accounts={options?.accounts ?? []}
          siblings={rows.filter((r) =>
            r.id !== editRow.id
            && r.event === editRow.event
            && normalizeId(r.customer) === normalizeId(editRow.customer)
            && (r.status === "pending" || r.status === "awaiting_bank_info" || r.status === "ready_to_refund")
            && r.refundAmount > 0)}
          onUpdated={handleUpdated}
          onOpenGroup={() => {
            const all = rows.filter((r) => pairKey(r) === pairKey(editRow) && isOpenRefund(r))
            setEditRow(null)
            setGroupSheet(all)
          }}
          onDeleted={() => handleDeleted(editRow.id)}
          onClose={() => setEditRow(null)}
        />
      )}
    </>
  )
}

// ─── The group sheet ─────────────────────────────────────────────────────────

/**
 * Everything one customer is owed on one trip, in one sheet.
 *
 * The refunds stay separate rows because each is its own explanation. What is
 * NOT separate is the customer: she has one bank account, she gets one message,
 * and she gets one transfer. Opening three sheets to say the same three things
 * to the same person is how she ends up with three WhatsApp messages about one
 * trip, and how one of the three gets forgotten.
 *
 * So the shared half sits at the top -- her account, the message, the transfer
 * -- and the refunds are listed below it, each opening to its own sheet for the
 * things that really are its own: the note, the credit, cancelling it.
 */
function RefundGroupSheet({
  refunds,
  accounts,
  onClose,
  onChanged,
  onOpenOne,
}: {
  refunds: RefundRow[]
  accounts: string[]
  onClose: () => void
  onChanged: () => void
  onOpenOne: (row: RefundRow) => void
}) {
  const templates = useMessageTemplates()
  const known = refunds.find((r) => r.bankAccountNumber?.trim())
  const [bankName, setBankName] = useState(known?.bankName ?? "")
  const [bankAccountNumber, setBankAccountNumber] = useState(known?.bankAccountNumber ?? "")
  const [bankAccountHolder, setBankAccountHolder] = useState(known?.bankAccountHolder ?? "")
  const [account, setAccount] = useState("")
  const [transferRef, setTransferRef] = useState("")
  const [picked, setPicked] = useState<Set<number>>(() => new Set(refunds.map((r) => r.id)))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showMessage, setShowMessage] = useState(false)

  const who = refunds[0].customer
  const whatsapp = useCustomerWhatsApp(who)
  const event = refunds[0].event
  const chosen = refunds.filter((r) => picked.has(r.id))
  const total = chosen.reduce((n, r) => n + displayAmount(r), 0)
  const canSend = chosen.length > 0 && bankAccountNumber.trim() !== ""
    && account.trim() !== "" && transferRef.trim() !== ""

  /**
   * One message for the lot.
   *
   * Each refund keeps its own sentence -- "we could not buy", "lost in
   * shipping", "arrived damaged" are different things to be told -- and they
   * stack under one figure, which is what she will actually receive. Sending
   * them separately makes three messages that each look like the whole story.
   *
   * The items come from each refund's own note, which is where a mark writes
   * them as it goes. An overpayment has no items and its sentence does not want
   * any.
   */
  const waMessageText = useMemo(() => {
    const causeText = chosen.map((r) => {
      const cause = REFUND_CAUSES.find((c) => c.key === r.reason)
      const items = r.reason === "overpayment"
        ? ""
        : r.note.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => `- ${l}`).join("\n")
      if (!cause) return ""
      return fillNotice(causeLineFor(cause, { items }, "whatsapp"), {
        "{event}": event,
        "{itemsList}": items,
        "{receivedItem}": "",
      })
    }).filter(Boolean).join("\n\n")

    const allItems = chosen
      .filter((r) => r.reason !== "overpayment")
      .flatMap((r) => r.note.split("\n").map((l) => l.trim()).filter(Boolean))
      .map((l) => `- ${l}`)
      .join("\n")

    const vars = {
      customer: who,
      event,
      itemsList: allItems,
      receivedItem: "",
      cause: causeText,
      refundAmount: formatRp(total),
    }
    return allItems
      ? fillTemplate(templates?.refund_specific ?? DEFAULT_TEMPLATES.refund_specific, vars)
      : fillTemplate(templates?.refund_generic ?? DEFAULT_TEMPLATES.refund_generic, vars)
  }, [chosen, who, event, total, templates])

  /**
   * Her account, saved onto every refund at once and onto her customer record.
   *
   * One account receives the money, so asking three times is asking once,
   * badly. Rows already at the transfer step are moved along with the rest.
   */
  async function saveBank() {
    if (!bankAccountNumber.trim()) { setError("An account number is required"); return }
    setSaving(true)
    setError(null)
    try {
      for (const r of refunds) {
        const res = await fetch(`/api/sheets/refunds/${r.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: "ready_to_refund",
            bankName: bankName.trim(),
            bankAccountNumber: bankAccountNumber.trim(),
            bankAccountHolder: bankAccountHolder.trim(),
          }),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error ?? "Failed to save her account")
        }
      }
      await fetch("/api/sheets/customer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instagramId: who,
          bankName: bankName.trim(),
          bankAccountNumber: bankAccountNumber.trim(),
          bankAccountHolder: bankAccountHolder.trim(),
        }),
      }).catch(() => {})
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save her account")
      setSaving(false)
    }
  }

  async function send() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/sheets/refunds/${chosen[0].id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "execute_group",
          refundIds: chosen.map((r) => r.id),
          transferReference: transferRef.trim(),
          account: account.trim(),
          bankName: bankName.trim(),
          bankAccountNumber: bankAccountNumber.trim(),
          bankAccountHolder: bankAccountHolder.trim(),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to pay these refunds")
      if (Array.isArray(data.skipped) && data.skipped.length > 0) {
        setError(`${data.skipped.length} of them had nothing owed any more and were left alone.`)
        setSaving(false)
      }
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to pay these refunds")
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6" onClick={onClose}>
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-lg flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-3 p-5 pb-3 border-b border-cream-border">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground truncate">{displayIg(who)}</div>
            <div className="text-xs text-faint mt-0.5">
              {event} · {refunds.length} refunds · <span className="tabular-nums font-medium text-muted-strong">{formatRp(total)}</span>
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-faint hover:text-brand transition-colors shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
          {/* What she is owed, and what each of them is about. Ticking decides
              what this transfer settles; opening one goes to its own sheet for
              the note, the credit, and cancelling it. */}
          <div className="flex flex-col gap-1">
            {refunds.map((r) => (
              <div key={r.id} className="flex items-start gap-2.5 px-2 py-2 rounded-lg bg-surface-muted">
                <input
                  type="checkbox"
                  checked={picked.has(r.id)}
                  disabled={saving}
                  onChange={(e) => setPicked((prev) => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(r.id)
                    else next.delete(r.id)
                    return next
                  })}
                  className="accent-brand mt-0.5"
                />
                <button
                  type="button"
                  onClick={() => onOpenOne(r)}
                  className="flex-1 min-w-0 text-left"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-foreground">{reasonLabel(r.reason)}</span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${statusColor(r)}`}>
                      {statusLabel(r)}
                    </span>
                  </div>
                  {r.note.split("\n").map((l) => l.trim()).filter(Boolean).map((l, i) => (
                    <div key={i} className="text-xs text-faint leading-snug">{l}</div>
                  ))}
                </button>
                <span className="tabular-nums text-sm font-semibold text-foreground shrink-0">
                  {formatRp(displayAmount(r))}
                </span>
              </div>
            ))}
          </div>

          {/* Her account — one, whatever she is owed it for. */}
          <div className="flex flex-col gap-2 p-3 rounded-lg bg-surface-muted border border-cream-border">
            <div className="text-xs font-medium text-muted-strong">Her account</div>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">Bank</span>
                <input value={bankName} onChange={(e) => setBankName(e.target.value)} disabled={saving}
                  placeholder="e.g. BCA" className={`${INPUT_CLASS} w-full`} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">Account number <span className="text-brand">*</span></span>
                <input value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)} disabled={saving}
                  placeholder="e.g. 1234567890" className={`${INPUT_CLASS} w-full`} />
              </label>
              <label className="flex flex-col gap-1 col-span-2">
                <span className="text-xs font-medium text-muted">Account holder</span>
                <input value={bankAccountHolder} onChange={(e) => setBankAccountHolder(e.target.value)} disabled={saving}
                  placeholder="Full name on the account" className={`${INPUT_CLASS} w-full`} />
              </label>
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={saveBank} disabled={saving || !bankAccountNumber.trim()}
                className="text-xs px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
                Save to all {refunds.length}
              </button>
            </div>
          </div>

          {/* One message, one figure, every reason inside it. */}
          <div className="flex flex-col gap-2 p-3 rounded-lg bg-surface-muted border border-cream-border">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-medium text-muted-strong">Message · one for all {chosen.length}</div>
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => setShowMessage((v) => !v)}
                  className="text-xs px-2 py-1 rounded border border-cream-border text-muted hover:bg-surface-sunken">
                  {showMessage ? "Hide" : "Preview"}
                </button>
                <MessageButton
                  kind="refund"
                  message={waMessageText}
                  whatsapp={whatsapp}
                  disabled={!templates}
                  className="text-xs px-2 py-1 rounded border border-cream-border text-muted-strong hover:border-brand hover:text-brand transition-colors disabled:opacity-50"
                  copyLabel="Copy"
                  sendLabel="WhatsApp"
                />
              </div>
            </div>
            {showMessage && (
              <pre className="text-[11px] text-muted-strong whitespace-pre-wrap font-sans bg-white rounded-lg border border-cream-border p-2 max-h-56 overflow-y-auto">
                {waMessageText}
              </pre>
            )}
          </div>

          {/* One transfer. */}
          <div className="flex flex-col gap-2 p-3 rounded-lg bg-surface-muted border border-cream-border">
            <div className="text-xs font-medium text-muted-strong">Transfer</div>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">Sent from account <span className="text-brand">*</span></span>
              <SearchableSelect
                value={account}
                onChange={setAccount}
                options={accounts.map((a) => ({ value: a, label: a }))}
                placeholder="Which of our accounts sent it…"
                allowNewValue
                disabled={saving}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">Transfer reference <span className="text-brand">*</span></span>
              <input value={transferRef} onChange={(e) => setTransferRef(e.target.value)} disabled={saving}
                placeholder="e.g. TRF20260828-014" className={`${INPUT_CLASS} w-full`} />
            </label>
          </div>

          {error && <p className="text-xs text-brand font-medium">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-3 p-4 border-t border-cream-border">
          <span className="text-xs text-muted">
            {chosen.length} of {refunds.length} · one reference
          </span>
          <button type="button" onClick={send} disabled={!canSend || saving}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-dark disabled:opacity-50">
            {saving ? "Sending…" : `Refund ${formatRp(total)}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Create refund card ──────────────────────────────────────────────────────

function CreateRefundCard({
  events,
  customers,
  customerMobiles,
  reasonOptions,
  onCreated,
  onClose,
}: {
  events: string[]
  customers: string[]
  customerMobiles?: Record<string, string>
  reasonOptions: { value: string; label: string }[]
  /** The notice route returns an id, not a row, so the list reloads. */
  onCreated: () => void
  onClose: () => void
}) {
  const [form, setForm] = useState({
    event: "",
    customer: "",
    reason: "" as RefundReason,
    refundAmount: "",
    note: "",
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { marks } = useHitAndRun()

  // Typing a handle by hand is how a refund lands on a customer who does not
  // exist -- one typo and the row is filed against nobody, invisible to her
  // invoice and to every total. The same picker the order forms use, so the
  // handle here is the handle there, flag and all.
  const customerOptions = useMemo(
    () => customers.map((c) => {
      const stamps = marks.get(handleKey(c))
      return {
        value: c,
        label: displayIg(c),
        meta: customerMobiles?.[c] || undefined,
        badge: stamps?.length ? <HitAndRunFlag stamps={stamps} /> : undefined,
      }
    }),
    [customers, customerMobiles, marks],
  )

  // Which lines it is about, for a reason that names them, and how many units
  // of each. Only fetched once there is a customer and an event to fetch for.
  const [lines, setLines] = useState<InvoiceOrderLine[]>([])
  const [picked, setPicked] = useState<Record<number, number>>({})
  const [goods, setGoods] = useState<"kept" | "returned" | "returned_unsellable">("kept")

  const needsLines = MANUAL_REFUND_CAUSES.find((c) => c.key === form.reason)?.needsItems === true

  useEffect(() => {
    if (!needsLines || !form.event || !form.customer.trim()) { setLines([]); return }
    let live = true
    fetch(`/api/sheets/invoice?customer=${encodeURIComponent(form.customer.trim())}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { events?: InvoiceEvent[] }) => {
        if (!live) return
        setLines(d.events?.find((e) => e.eventId === form.event)?.orders ?? [])
      })
      .catch(() => { if (live) setLines([]) })
    return () => { live = false }
  }, [needsLines, form.event, form.customer])

  // What the picked lines come to. Prefilled, not imposed: she may be keeping
  // the item at a discount rather than sending it back for all of it.
  const pickedTotal = lines.reduce((sum, o) => sum + o.rawUnitPrice * (picked[o.orderId] ?? 0), 0)
  // Same shape a mark writes: name, count, price each. A refund raised by hand
  // and one raised by a mark end up on the same screen, and reading differently
  // makes them look like different kinds of thing.
  const pickedItems = lines
    .filter((o) => (picked[o.orderId] ?? 0) > 0)
    .map((o) => `${o.productName} × ${picked[o.orderId]}`
      + ` × Rp ${new Intl.NumberFormat("id-ID").format(o.rawUnitPrice)}`)
    .join(", ")

  useEffect(() => {
    if (needsLines && pickedTotal > 0) setForm((f) => ({ ...f, refundAmount: String(pickedTotal) }))
  }, [needsLines, pickedTotal])

  // The same wording a marked refund sends, filled from what is typed here, so
  // one customer cannot receive two different explanations of the same thing.
  const cause = MANUAL_REFUND_CAUSES.find((c) => c.key === form.reason)
  const template = NOTICE_TEMPLATES.find((t) => t.key === "inbox_refund_offered")!
  const tokens = {
    "{customer}": form.customer.trim(),
    "{event}": form.event,
    "{refundAmount}": formatRp(Number(form.refundAmount) || 0),
    "{itemsList}": pickedItems || form.note.trim() || "pesanan Anda",
    "{cause}": "",
  }
  const causeLine = cause
    ? fillNotice(causeLineFor(cause, { items: pickedItems || form.note.trim() }), tokens)
    : ""
  const noticeTitle = fillNotice(template.title, tokens)
  const noticeBody = fillNotice(template.body, { ...tokens, "{cause}": causeLine })

  function field<K extends keyof typeof form>(key: K) {
    return {
      value: form[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
        setForm((f) => ({ ...f, [key]: e.target.value })),
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      // Through the notice, so a refund written by hand tells her the same way
      // a marked one does. She never reads an adjustment or a refund's own
      // description — the notice is the only surface that explains itself, and
      // creating one silently was the difference between these two routes.
      const res = await fetch("/api/sheets/invoice/notice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: form.event,
          customer: form.customer.trim(),
          title: noticeTitle,
          body: noticeBody,
          refund: {
            cause: form.reason,
            amount: Number(form.refundAmount),
            items: pickedItems || form.note.trim(),
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to create")

      // Goods coming back are stock, and stock the books have to know about.
      // After the refund, so a failure here cannot leave money unexplained.
      if (needsLines && goods !== "kept") {
        for (const o of lines) {
          const units = picked[o.orderId] ?? 0
          if (units <= 0) continue
          await fetch("/api/sheets/excess-purchase", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event: form.event, items: o.productName, unitBuy: units, reason: goods,
            }),
          })
        }
      }

      setForm({ event: "", customer: "", reason: "" as RefundReason, refundAmount: "", note: "" })
      setPicked({})
      setGoods("kept")
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-t-xl md:rounded-xl border-x border-t border-cream-border md:border bg-white p-5 pb-8 md:pb-5 flex flex-col gap-4">
      <div className="flex items-center justify-between -mx-5 px-5 border-b border-cream-border pb-3 md:mx-0 md:px-0 md:border-b-0 md:pb-0">
        <span className="text-base md:text-sm font-semibold text-foreground">New Refund</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Event</span>
          <EventSelect value={form.event} onChange={(v) => setForm((f) => ({ ...f, event: v }))} events={events} disabled={saving} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Customer</span>
          <SearchableSelect
            value={form.customer}
            onChange={(v) => setForm((f) => ({ ...f, customer: v }))}
            options={customerOptions}
            placeholder="Search customer…"
            disabled={saving}
            searchMeta
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Reason</span>
          {/* Only the reasons nobody can mark. Sold out, damaged, missing and
              wrong deliveries are made on the Shopping or Arrival List, where
              one action reduces the order, writes the refund and sends the
              notice — offering them here invites a second refund for the same
              thing, on an order still claiming units she will never get. */}
          <SearchableSelect
            value={form.reason}
            onChange={(v) => setForm((f) => ({ ...f, reason: v }))}
            options={MANUAL_REFUND_CAUSES.map((c) => ({ value: c.key, label: reasonLabel(c.key) }))}
            placeholder="Select…"
            disabled={saving}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Refund Amount (Rp)</span>
          <input
            {...field("refundAmount")}
            type="number"
            min="1"
            required
            disabled={saving}
            placeholder="e.g. 150000"
            className={`${INPUT_CLASS} w-full`}
          />
        </label>
      </div>

      {/* Which lines, for a reason that names them. A quality complaint is
          about a thing she is holding, so the notice has to say which thing —
          and the amount follows from it rather than being guessed. */}
      {needsLines && lines.length > 0 && (
        <div className="rounded-lg border border-cream-border bg-surface-muted p-3 flex flex-col gap-2">
          <span className="text-xs font-medium text-muted">Barang yang dikeluhkan</span>
          {lines.map((o) => (
            <label key={o.orderId} className="flex items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={(picked[o.orderId] ?? 0) > 0}
                onChange={(e) =>
                  setPicked((p) => ({ ...p, [o.orderId]: e.target.checked ? o.unit : 0 }))}
                disabled={saving}
                className="accent-brand"
              />
              <span className="flex-1 min-w-0 truncate">{o.productName}</span>
              {(picked[o.orderId] ?? 0) > 0 && (
                <input
                  type="number"
                  min="1"
                  max={o.unit}
                  value={picked[o.orderId]}
                  onChange={(e) => setPicked((p) => ({
                    ...p,
                    [o.orderId]: Math.min(o.unit, Math.max(1, Number(e.target.value) || 1)),
                  }))}
                  disabled={saving}
                  className="w-16 px-2 py-1 rounded border border-cream-border text-sm tabular-nums"
                />
              )}
              <span className="text-xs text-faint tabular-nums w-24 text-right">
                {formatRp(o.rawUnitPrice)} × {o.unit}
              </span>
            </label>
          ))}
        </div>
      )}

      {/* Where the goods ended up. Three real outcomes, and the shop knows
          which — the refund cannot work it out, and guessing either invents
          stock or loses it. */}
      {needsLines && pickedTotal > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Barangnya</span>
          <div className="flex flex-wrap gap-2">
            {([
              ["kept", "Tetap di customer"],
              ["returned", "Dikembalikan — masih bisa dijual"],
              ["returned_unsellable", "Dikembalikan — tidak bisa dijual"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setGoods(value)}
                disabled={saving}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  goods === value
                    ? "bg-brand text-white border-brand"
                    : "border-cream-border text-muted-strong hover:bg-surface-muted"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-faint">
            {goods === "kept"
              ? "Tidak ada yang masuk Inventory."
              : goods === "returned"
                ? "Masuk Inventory sebagai stok siap dijual."
                : "Masuk Inventory, tercatat tapi tidak ditawarkan ke pesanan lain."}
          </span>
        </div>
      )}

      {!needsLines && (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">
            What it is for <span className="font-normal text-faint">(shown in the notice)</span>
          </span>
          <textarea {...field("note")} disabled={saving} rows={2} placeholder="mis. keterlambatan 3 minggu" className={`${INPUT_CLASS} w-full resize-none`} />
        </label>
      )}

      {/* Shown before it goes, because it goes: a refund made here now sends
          the customer the same notice a marked one does. */}
      {Number(form.refundAmount) > 0 && form.event && form.reason && (
        <div className="rounded-lg border border-purple-200 bg-purple-50 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-purple-700 mb-1.5">
            Yang dia terima
          </div>
          <div className="text-sm font-semibold text-foreground">{noticeTitle}</div>
          <p className="text-xs text-muted-strong whitespace-pre-wrap mt-1 leading-relaxed">{noticeBody}</p>
        </div>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-cream-border text-muted-strong text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
          Cancel
        </button>
        <button type="submit" disabled={saving || !form.reason || (needsLines && pickedTotal <= 0)} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors">
          {saving ? "Mengirim…" : "Create & send notice"}
        </button>
      </div>
    </form>
  )
}

// ─── Refund detail modal ──────────────────────────────────────────────────────

// The cash-refund pipeline as linear steps, up to the last one with an action.
// Once transferred the refund goes read-only and shows a "Transfer Complete"
// summary instead — no separate "Done" node needed. Terminal side-tracks
// (cancelled, applied_to_next_order) render their own blocks instead of this.
const FLOW_STEPS: { status: RefundStatus; label: string }[] = [
  { status: "pending", label: "Message" },
  { status: "awaiting_bank_info", label: "Bank Info" },
  { status: "ready_to_refund", label: "Transfer" },
]

function StepIndicator({ status }: { status: RefundStatus }) {
  const current = FLOW_STEPS.findIndex((s) => s.status === status)
  if (current < 0) return null
  return (
    <div className="flex items-center px-6 py-3 border-b border-cream-border">
      {FLOW_STEPS.map((step, i) => (
        <div key={step.status} className={`flex items-center ${i > 0 ? "flex-1" : ""}`}>
          {i > 0 && <div className={`flex-1 h-px mx-2 ${i <= current ? "bg-brand" : "bg-cream-border"}`} />}
          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center border ${
                i < current
                  ? "bg-brand border-brand text-white"
                  : i === current
                    ? "border-brand text-brand bg-white"
                    : "border-cream-border text-faint bg-white"
              }`}
            >
              {i < current ? "✓" : i + 1}
            </span>
            <span className={`text-[11px] ${i === current ? "font-semibold text-brand" : "text-faint"}`}>
              {step.label}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function RefundDetailModal({
  row,
  accounts,
  siblings,
  onUpdated,
  onOpenGroup,
  onDeleted,
  onClose,
}: {
  row: RefundRow
  /** OUR bank names (BCA/JAGO/...) for the execute step's Account picker. */
  accounts: string[]
  /** Her other unpaid refunds on this same trip, offered in the same transfer. */
  siblings: RefundRow[]
  onUpdated: (updated: RefundRow) => void
  /** Take the whole trip's worth to the group sheet, where paying lives. */
  onOpenGroup: () => void
  onDeleted: () => void
  onClose: () => void
}) {
  const [bankName, setBankName] = useState(row.bankName)
  const [bankAccountNumber, setBankAccountNumber] = useState(row.bankAccountNumber)
  const [bankAccountHolder, setBankAccountHolder] = useState(row.bankAccountHolder)
  const [transferRef, setTransferRef] = useState(row.transferReference)
  const [refundAccount, setRefundAccount] = useState("")
  const [note, setNote] = useState(row.note)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const [invoiceEvent, setInvoiceEvent] = useState<InvoiceEvent | null>(null)
  const [invoiceLoading, setInvoiceLoading] = useState(true)
  const [invoiceError, setInvoiceError] = useState<string | null>(null)
  // Collapsed-by-default sections keep the modal short enough to never scroll
  // in the common case — the old layout hid half the workflow below the fold.
  const [showMessage, setShowMessage] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  // Opens the full invoice as a drawer over this modal instead of navigating
  // away to /dashboard/invoice, so the refund list keeps its place.
  const [showFullInvoice, setShowFullInvoice] = useState(false)

  // Apply-as-credit flow: the customer's other orders are the valid targets.
  const [customerEvents, setCustomerEvents] = useState<InvoiceEvent[]>([])
  // Open on a promised credit: applying it is the only reason this refund is
  // still on the list.
  const [showCredit, setShowCredit] = useState(() => isCreditPromised(row))
  const [creditTarget, setCreditTarget] = useState("")
  const [creditAmount, setCreditAmount] = useState("")

  useEffect(() => {
    let cancelled = false
    setInvoiceLoading(true)
    setInvoiceError(null)
    fetchJson<InvoiceResult>(`/api/sheets/invoice?customer=${encodeURIComponent(row.customer)}`)
      .then((data) => {
        if (cancelled) return
        setCustomerEvents(data.events)
        const match = data.events.find((ev) => ev.eventId === row.event) ?? null
        setInvoiceEvent(match)
        if (!match) setInvoiceError("No invoice found for this event")
      })
      .catch((err) => {
        if (!cancelled) setInvoiceError(err instanceof Error ? err.message : "Failed to load invoice")
      })
      .finally(() => { if (!cancelled) setInvoiceLoading(false) })
    return () => { cancelled = true }
  }, [row.customer, row.event])

  // A promised credit is deliberately NOT read-only: closing it is what left it
  // with no way to be applied once the customer's next order finally existed.
  const isReadOnly = !isCreditPromised(row)
    && (row.status === "refunded" || row.status === "cancelled" || row.status === "applied_to_next_order")

  // The same customer's other trips that still owe money. Refunds are per trip,
  // so nothing on this one says the person you are about to pay is already
  // behind on another — and marks now create refunds without anyone asking.
  const owedElsewhere = useMemo(
    () =>
      customerEvents
        .filter((ev) => ev.eventId !== row.event && ev.invoice.sisaPelunasan > 0)
        .map((ev) => ({ event: ev.eventId, amount: ev.invoice.sisaPelunasan }))
        .sort((a, b) => b.amount - a.amount),
    [customerEvents, row.event],
  )


  async function patch(body: object) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/sheets/refunds/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      return false
    } finally {
      setSaving(false)
    }
  }

  async function handleStatusChange(status: RefundStatus) {
    const ok = await patch({ status })
    if (ok) onUpdated({ ...row, status })
  }

  async function handleApplyCredit() {
    if (!creditTarget) { setError("Pick a target order"); return }
    const amt = Math.round(Number(creditAmount))
    if (!Number.isFinite(amt) || amt <= 0) { setError("Enter a valid amount"); return }
    if (amt > row.refundAmount) { setError(`Amount exceeds the overpayment (${formatRp(row.refundAmount)})`); return }
    const ok = await patch({ action: "apply_credit", targetEvent: creditTarget, amount: amt })
    if (ok) {
      const remaining = row.refundAmount - amt
      onUpdated({
        ...row,
        refundAmount: Math.max(0, remaining),
        appliedCreditAmount: (row.appliedCreditAmount ?? 0) + amt,
        status: remaining <= 0 ? "applied_to_next_order" : "pending",
        hasAppliedCredit: true,
        note: remaining <= 0
          ? `Applied as credit to ${creditTarget}`
          : `Applied ${formatRp(amt)} as credit to ${creditTarget}; ${formatRp(remaining)} overpayment remaining`,
      })
      setShowCredit(false); setCreditTarget(""); setCreditAmount("")
    }
  }

  // Reverses the credit payments and reopens — for when it was applied to the
  // wrong order (or by mistake). Restores the full overpayment.
  /**
   * She said keep it, in a DM rather than by pressing it herself.
   *
   * Parks the money on her account with no target order named: the same state
   * her own choice on the catalogue produces, and the one the deposit banner
   * on her next invoice looks for. Until this existed the only honest thing to
   * do was leave the refund Pending, which reads as "we owe her and have not
   * paid yet" and sits on the Pending tab as work nobody means to do.
   */
  async function handleKeepOnAccount() {
    const ok = await patch({ action: "keep_on_account" })
    if (ok) onUpdated({
      ...row,
      status: "applied_to_next_order",
      bankName: "", bankAccountNumber: "", bankAccountHolder: "",
    })
  }

  async function handleUndoCredit() {
    const ok = await patch({ action: "undo_credit" })
    if (ok) onUpdated({
      ...row,
      status: "pending",
      hasAppliedCredit: false,
      // Restore the full overpayment = remaining + what had been applied.
      refundAmount: row.refundAmount + (row.appliedCreditAmount ?? 0),
      appliedCreditAmount: 0,
      note: "",
    })
  }

  async function handleSaveBankInfo() {
    const ok = await patch({ status: "ready_to_refund", bankName, bankAccountNumber, bankAccountHolder })
    if (!ok) return
    // Also update customer's bank info for future reuse
    await fetch("/api/sheets/customer", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instagramId: row.customer, bankName, bankAccountNumber, bankAccountHolder }),
    })
    onUpdated({ ...row, status: "ready_to_refund", bankName, bankAccountNumber, bankAccountHolder })
  }

  async function handleExecute() {
    if (!transferRef.trim()) { setError("Transfer reference is required"); return }
    if (!refundAccount.trim()) { setError("Pick the account the refund was sent from"); return }
    const ok = await patch({ action: "execute", transferReference: transferRef.trim(), account: refundAccount.trim() })
    if (ok) onUpdated({ ...row, status: "refunded", transferReference: transferRef.trim() })
  }

  // Where this row's figure came from, which is the sentence to show in place
  // of the box that used to be here.
  const amountIsLive = isLiveAmount({ reason: row.reason, status: row.status })

  async function handleSaveEdit() {
    const ok = await patch({ note })
    if (ok) {
      onUpdated({ ...row, note })
      setShowEdit(false)
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this refund? This cannot be undone.")) return
    setSaving(true)
    try {
      const res = await fetch(`/api/sheets/refunds/${row.id}`, { method: "DELETE" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to delete")
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete")
      setSaving(false)
    }
  }

  // Fully-cancelled invoice lines (unit === 0 is the canonical void marker) are
  // the items that became unavailable — name them in the message. Lines merely
  // reduced (e.g. 3 → 2) keep no record of the original quantity, so partial
  // shortages can't be listed and the message falls back to the generic phrasing.
  const unavailableLines = (invoiceEvent?.orders ?? []).filter((o) => o.unit === 0)
  const unavailableItems = unavailableLines.map((o) => o.productName)
  const templates = useMessageTemplates()

  // A mark writes what it removed onto the refund, quantities and all, which is
  // better than anything this screen can reconstruct: a line reduced 3 → 2
  // keeps no record of the original, so orders alone can only see what went to
  // zero.
  //
  // But one refund can cover several marks. Five products marked out of stock
  // write five notes, and if those refunds are merged into one the note names
  // whichever mark happened to write it -- so she is told about one item and
  // refunded for five. The note leads, because it carries quantities, and
  // anything else that went to zero on this trip is named after it.
  //
  // Only where the cause is about items. An overpayment's note says what the
  // money was, not what was lost, and cancelled lines are none of its business.
  const itemsCause = REFUND_CAUSES.find((c) => c.key === row.reason)
  const noteLines = (row.note ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-•]\s*/, "").trim())
    .filter(Boolean)
  // One item per line, with what it costs.
  //
  // The invoice leads here, because it is the only place the price lives. A
  // note may name the same items in full or in shorthand -- "Cooling Towel,
  // Bucket Hat, Simple Cap — 5 item" is how a person summarises five marks
  // merged into one refund -- so it is used to recognise what the invoice
  // already shows, and to add anything the invoice cannot: a line reduced 3 to
  // 2 keeps no record of the original, so only the note knows it happened.
  const fragments = noteLines
    .flatMap((l) => l.split(/[,;·—–]|\s×\s/))
    .map((f) => f.trim().toLowerCase())
    .filter((f) => f.length > 3)

  /** "Bucket Hat with String × 1" out of a note line, when it says a count. */
  function qtyFor(name: string): number | null {
    for (const line of noteLines) {
      const m = line.match(/×\s*(\d+)/)
      if (!m) continue
      const before = line.slice(0, line.indexOf("×")).trim().toLowerCase()
      if (before && (name.toLowerCase().includes(before) || before.includes(name.toLowerCase()))) {
        return Number(m[1])
      }
    }
    return null
  }

  const named: string[] = []
  if (itemsCause?.needsItems) {
    for (const line of unavailableLines) {
      const qty = qtyFor(line.productName)
      const each = line.rawUnitPrice
      // Price per unit, and the total beside it when more than one went. She
      // checks the arithmetic; making her multiply is making her work.
      const money = each > 0
        ? qty && qty > 1
          ? ` — ${qty} × ${formatRp(each)} = ${formatRp(each * qty)}`
          : ` — ${formatRp(each)}`
        : ""
      named.push(`${line.productName}${qty && qty > 1 ? ` × ${qty}` : ""}${money}`)
    }
    // Anything the note mentions that no zeroed line accounts for: a partial
    // shortage, which leaves nothing behind on the order to find.
    for (const line of noteLines) {
      const known = unavailableItems.some((item) => {
        const name = item.toLowerCase()
        return fragments.some((f) => name.includes(f) || f.includes(name))
      })
      if (!known) named.push(line)
    }
  } else {
    named.push(...noteLines)
  }

  const itemsList = named.length
    ? named.map((n) => `- ${n}`).join("\n")
    : unavailableItems.map((n) => `- ${n}`).join("\n")

  // What arrived instead, where a wrong delivery was marked on this trip.
  const [receivedMap, setReceivedMap] = useState<Record<string, string>>({})
  const wantsReceived = REFUND_CAUSES.find((c) => c.key === row.reason)?.needsReceived === true
  useEffect(() => {
    if (!wantsReceived) return
    let live = true
    fetch(`/api/sheets/wrong-deliveries?event=${encodeURIComponent(row.event)}`)
      .then((r) => r.json())
      .then((d: { received?: Record<string, string> }) => { if (live) setReceivedMap(d.received ?? {}) })
      // Silent: the wording drops to the sentence that does not name it.
      .catch(() => {})
    return () => { live = false }
  }, [wantsReceived, row.event])
  const receivedItem = [...new Set(Object.values(receivedMap))].join(", ")

  // The reason, said out loud — the same one the inbox card gives, in the
  // language this channel speaks. Before this, every refund reached WhatsApp as
  // an item being out of stock, whatever had actually happened.
  const cause = REFUND_CAUSES.find((c) => c.key === row.reason)
  const causeText = cause
    ? fillNotice(causeLineFor(cause, { items: itemsList, receivedItem }, "whatsapp"), {
        "{event}": row.event,
        "{itemsList}": itemsList,
        "{receivedItem}": receivedItem,
      })
    : `Ada pengembalian dana untuk pesanan Anda pada event *${row.event}*.`

  const waVars = {
    customer: row.customer,
    event: row.event,
    itemsList,
    receivedItem,
    cause: causeText,
    refundAmount: formatRp(row.refundAmount),
  }
  const waMessageText = itemsList
    ? fillTemplate(templates?.refund_specific ?? DEFAULT_TEMPLATES.refund_specific, waVars)
    : fillTemplate(templates?.refund_generic ?? DEFAULT_TEMPLATES.refund_generic, waVars)
  const whatsapp = useCustomerWhatsApp(row.customer)

  async function handleCopyMessage() {
    try {
      await navigator.clipboard.writeText(waMessageText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError("Failed to copy")
    }
  }

  // One always-visible primary action per step, pinned in the footer — the old
  // layout buried each step's CTA inside a scroll area with no scroll affordance.
  const primaryAction =
    row.status === "pending" ? (
      <button
        onClick={() => handleStatusChange("awaiting_bank_info")}
        disabled={saving}
        className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
      >
        Sent
      </button>
    ) : row.status === "awaiting_bank_info" ? (
      <button
        onClick={handleSaveBankInfo}
        disabled={saving || !bankName || !bankAccountNumber || !bankAccountHolder}
        className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
      >
        {saving ? "Saving…" : "Save"}
      </button>
    ) : row.status === "ready_to_refund" ? (
      <button
        onClick={handleExecute}
        disabled={saving || !transferRef.trim() || !refundAccount.trim()}
        className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
      >
        {saving ? "Processing…" : "Refund"}
      </button>
    ) : null

  const whatsAppCard = (
    <div className="flex flex-col gap-2 p-3 rounded-lg bg-surface-muted border border-cream-border">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted-strong">Refund message</div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowMessage((v) => !v)}
            title={showMessage ? "Hide message" : "Preview message"}
            className="inline-flex items-center justify-center w-6 h-6 rounded border border-cream-border text-muted hover:bg-surface-sunken transition-colors shrink-0"
          >
            {showMessage ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-10-8-10-8a18.4 18.4 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19" />
                <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                <path d="M1 1l22 22" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s3-8 11-8 11 8 11 8-3 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
          {/* One button, doing whichever thing Settings → Communication says
              this shop does with a refund message. */}
          <MessageButton
            kind="refund"
            message={waMessageText}
            whatsapp={whatsapp}
            disabled={!templates}
            className="px-2 py-1 rounded border border-cream-border text-[11px] text-muted-strong hover:border-brand hover:text-brand transition-colors shrink-0 disabled:opacity-50"
            copyLabel="Copy"
            sendLabel="WhatsApp"
          />
        </div>
      </div>
      {showMessage ? (
        <p className="text-xs text-muted-strong whitespace-pre-wrap leading-relaxed">{waMessageText}</p>
      ) : null}
    </div>
  )

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center md:px-4" onClick={onClose}>
      <div
        className="bg-white rounded-t-xl md:rounded-xl border-x border-t border-cream-border md:border shadow-xl w-full flex flex-col gap-0 overflow-hidden max-h-[96vh] md:max-h-[90vh] md:max-w-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — identity + the one number that matters */}
        <div className="shrink-0 flex items-start justify-between gap-3 px-6 py-4 border-b border-cream-border">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2">
              <span className="text-sm font-semibold text-foreground">{row.event}</span>
              <span className="text-sm text-faint truncate uppercase">{displayIg(row.customer)}</span>
              {invoiceEvent && (
                <button
                  type="button"
                  onClick={() => setShowFullInvoice(true)}
                  aria-label="Open full invoice"
                  title="Open full invoice"
                  className="text-faint hover:text-brand transition-colors shrink-0"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  </svg>
                </button>
              )}
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-lg font-bold text-foreground tabular-nums">{formatRp(displayAmount(row))}</span>
              {isFullyAppliedAsCredit(row) && (
                <span className="text-[11px] text-faint">applied as credit</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${statusColor(row)}`}>
              {statusLabel(row)}
            </span>
          </div>
        </div>

        {/* Outstanding elsewhere — the credit offer, one click from taken. Only
            where a credit can still be applied; a settled refund is history. */}
        {!isReadOnly && owedElsewhere.length > 0 && (
          <div className="shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1.5 px-6 py-2.5 border-b border-purple-200 bg-purple-50">
            <span className="text-xs text-purple-800">
              <span className="font-semibold">Outstanding elsewhere</span> ·{" "}
              {owedElsewhere.map((t, i) => (
                <span key={t.event}>
                  {i > 0 && ", "}
                  <span className="font-bold tabular-nums">{formatRp(t.amount)}</span> on {t.event}
                </span>
              ))}
            </span>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                const top = owedElsewhere[0]
                setCreditTarget(top.event)
                setCreditAmount(String(Math.min(row.refundAmount, top.amount) || row.refundAmount))
                setShowCredit(true)
                // The panel this fills sits below the fold. Without this the
                // click reads as having done nothing at all.
                requestAnimationFrame(() =>
                  document.getElementById(CREDIT_PANEL_ID)?.scrollIntoView({ behavior: "smooth", block: "center" }),
                )
              }}
              className="ml-auto shrink-0 px-2.5 py-1 rounded-md text-xs font-medium bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 transition-colors"
            >
              Apply {formatRp(Math.min(row.refundAmount, owedElsewhere[0].amount))} to {owedElsewhere[0].event}
            </button>
          </div>
        )}

        {/* Invoice — one line, expandable. Was a 6-row block eating the modal.
            Hidden on mobile: the open-invoice icon in the header covers it there. */}
        <div className="hidden md:block shrink-0 border-b border-cream-border">
          {invoiceLoading ? (
            <div className="px-6 py-2.5 text-xs text-faint">Loading invoice…</div>
          ) : invoiceError ? (
            <div className="px-6 py-2.5 text-xs text-red-500">{invoiceError}</div>
          ) : invoiceEvent ? (
            <button
              type="button"
              onClick={() => setShowFullInvoice(true)}
              className="w-full flex items-center justify-between gap-2 px-6 py-2.5 text-xs hover:bg-surface-muted/60 transition-colors"
            >
              <span className="text-muted">
                Invoice <span className="font-semibold text-foreground tabular-nums">{formatRp(invoiceEvent.invoice.total)}</span>
                {" · "}Paid <span className="font-semibold text-foreground tabular-nums">{formatRp(invoiceEvent.invoice.pembayaran)}</span>
              </span>
            </button>
          ) : null}
        </div>

        {/* Pipeline position (cash flow only — terminal side-tracks skip it) */}
        {!isReadOnly && <StepIndicator status={row.status} />}

        <div className="flex-1 min-h-0 flex flex-col gap-3 md:gap-4 px-6 py-3 md:py-4 overflow-y-auto">
          {/* ── Current step ── */}

          {row.status === "pending" && whatsAppCard}

          {row.status === "awaiting_bank_info" && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-3 p-3 rounded-lg bg-surface-muted border border-cream-border">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-strong">Bank Name</span>
                  <input
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    disabled={saving}
                    placeholder="e.g. BCA, Mandiri"
                    className={`${INPUT_CLASS} w-full`}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-strong">Account Number</span>
                  <input
                    value={bankAccountNumber}
                    onChange={(e) => setBankAccountNumber(e.target.value)}
                    disabled={saving}
                    placeholder="e.g. 1234567890"
                    className={`${INPUT_CLASS} w-full`}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-strong">Account Holder Name</span>
                  <input
                    value={bankAccountHolder}
                    onChange={(e) => setBankAccountHolder(e.target.value)}
                    disabled={saving}
                    placeholder="Full name on account"
                    className={`${INPUT_CLASS} w-full`}
                  />
                </label>
              </div>
              {/* Customer hasn't replied yet? Message tools stay one click away. */}
              {whatsAppCard}
            </div>
          )}

          {row.status === "ready_to_refund" && (
            <div className="flex flex-col gap-3 p-3 rounded-lg bg-surface-muted border border-cream-border">
              <div className="text-xs font-medium text-muted-strong">Execute transfer</div>
              <div className="text-xs text-muted">
                Transfer <span className="font-bold text-foreground">{formatRp(row.refundAmount)}</span> to{" "}
                <span className="font-medium text-foreground">{row.bankName}</span> · {row.bankAccountNumber} · {row.bankAccountHolder}
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-strong">Sent from account <span className="text-brand">*</span></span>
                <SearchableSelect
                  value={refundAccount}
                  onChange={setRefundAccount}
                  options={accounts.map((a) => ({ value: a, label: a }))}
                  placeholder="Which of our accounts sent it..."
                  allowNewValue
                  disabled={saving}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-strong">Transfer Reference</span>
                <input
                  value={transferRef}
                  onChange={(e) => setTransferRef(e.target.value)}
                  disabled={saving}
                  placeholder="e.g. TRF20240510-001"
                  className={`${INPUT_CLASS} w-full`}
                />
              </label>

              {siblings.length > 0 && (
                <div className="flex items-center gap-2 pt-2 border-t border-cream-border">
                  <p className="flex-1 text-[11px] text-muted">
                    She is owed {siblings.length} more on {row.event}. Paying them together is one
                    transfer and one message.
                  </p>
                  <button
                    type="button"
                    onClick={onOpenGroup}
                    className="shrink-0 px-2.5 py-1 rounded-lg border border-brand text-brand text-[11px] font-semibold hover:bg-brand-light"
                  >
                    Open all {siblings.length + 1}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Refunded — show summary */}
          {row.status === "refunded" && (
            <div className="flex flex-col gap-1.5 p-3 rounded-lg bg-surface-muted border border-cream-border text-xs text-muted">
              <div className="font-medium text-muted-strong">Transfer complete</div>
              <div>Reference: <span className="font-medium text-foreground">{row.transferReference || "—"}</span></div>
              <div>Bank: <span className="font-medium text-foreground">{row.bankName} · {row.bankAccountNumber}</span></div>
              <div>Holder: <span className="font-medium text-foreground">{row.bankAccountHolder}</span></div>
            </div>
          )}

          {/* Cancelled, or marked applied with no credit actually moved (legacy
              label-only) — nothing to reverse, so a plain status reopen is safe. */}
          {(row.status === "cancelled" || (row.status === "applied_to_next_order" && !row.hasAppliedCredit)) && (
            <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-surface-muted border border-cream-border">
              <div className="text-xs text-muted-strong">
                {row.status === "cancelled"
                  ? "This refund was cancelled."
                  : "Marked as applied to a next order, but no credit was actually moved."}
                <br />
                <span className="text-faint">Pressed by mistake? Reopen to continue processing.</span>
              </div>
              <button
                type="button"
                onClick={() => handleStatusChange("pending")}
                disabled={saving}
                className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
              >
                ↩ Reopen
              </button>
            </div>
          )}

          {/* Credit applied (fully or partially) — undoing REVERSES the credit
              payments and restores the overpayment, not just relabels. */}
          {row.hasAppliedCredit && (
            <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-purple-50 border border-purple-200">
              <div className="text-xs text-purple-700">
                {row.note || "Applied as credit to another order."}
                <br />
                <span className="text-purple-500">Wrong order? Undo to reverse the credit{row.status !== "applied_to_next_order" ? " applied so far" : " and reopen this refund"}.</span>
              </div>
              <button
                type="button"
                onClick={handleUndoCredit}
                disabled={saving}
                className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-purple-300 text-purple-700 hover:border-purple-500 hover:bg-purple-100 disabled:opacity-50 transition-colors"
              >
                {saving ? "Undoing…" : "↩ Undo credit"}
              </button>
            </div>
          )}

          {/* Edit amount & note — off the main path, one click away */}
          {!isReadOnly && (
            <div className="flex flex-col gap-2 p-3 rounded-lg bg-surface-muted border border-cream-border">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-muted-strong">Note</div>
                <button
                  type="button"
                  onClick={() => setShowEdit((v) => !v)}
                  title={showEdit ? "Hide" : "Edit"}
                  className="inline-flex items-center justify-center w-6 h-6 rounded border border-cream-border text-muted hover:bg-surface-sunken transition-colors shrink-0"
                >
                  {showEdit ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
                    </svg>
                  )}
                </button>
              </div>
              {showEdit && (
                <div className="flex flex-col gap-3">
                  {/* The amount is set when the refund is made -- computed by
                      the mark, read from her balance, or typed into the
                      composer. There is no fourth kind, so there is no box. */}
                  <p className="text-[11px] text-faint">
                    <span className="font-medium text-muted">{formatRp(row.refundAmount)}</span>{" "}
                    {amountIsLive
                      ? `is what she is overpaid right now, less what her other open refunds on ${row.event} already claim. It follows her invoice.`
                      : "was set when this refund was made. To refund a different figure, cancel this one and make it again."}
                  </p>
                  {row.appliedCreditAmount > 0 && !isFullyAppliedAsCredit(row) && (
                    <p className="text-[11px] text-faint -mt-2">
                      {formatRp(row.appliedCreditAmount)} already applied as credit elsewhere — the amount above is what's still left to refund.
                    </p>
                  )}
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted">Note</span>
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      disabled={saving}
                      rows={2}
                      className={`${INPUT_CLASS} w-full resize-none`}
                    />
                  </label>
                  <div className="flex justify-end">
                    <button onClick={handleSaveEdit} disabled={saving} className="text-xs px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
                      {saving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {isReadOnly && row.note && (
            <p className="text-xs text-muted"><span className="font-medium text-faint">Note:</span> {row.note}</p>
          )}

          {/* Apply as credit — pick which of the customer's other orders to credit */}
          {!isReadOnly && (
            <div id={CREDIT_PANEL_ID} className="flex flex-col gap-2 p-3 rounded-lg bg-surface-muted border border-cream-border">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-muted-strong">Apply as credit</div>
                <button
                  type="button"
                  onClick={() => setShowCredit((v) => !v)}
                  title={showCredit ? "Hide" : "Apply as credit"}
                  className="inline-flex items-center justify-center w-6 h-6 rounded border border-cream-border text-muted hover:bg-surface-sunken transition-colors shrink-0"
                >
                  {showCredit ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                  )}
                </button>
              </div>
              {/* No target order yet -- and there need not be one. The money
                  waits on her account until an order of hers can take it. */}
              {!isCreditPromised(row) && (
                <div className="flex items-center justify-between gap-2 pb-1">
                  <p className="text-[11px] text-muted">
                    She just wants it kept? No order needs to exist yet.
                  </p>
                  <button
                    type="button"
                    onClick={handleKeepOnAccount}
                    disabled={saving}
                    className="shrink-0 px-2.5 py-1 rounded-lg border border-purple-300 text-purple-700 text-[11px] font-semibold hover:bg-purple-50 disabled:opacity-50 transition-colors"
                  >
                    Keep on her account
                  </button>
                </div>
              )}
              {showCredit && (
              <div className="flex flex-col gap-3">
              {isCreditPromised(row) && (
                <div className="text-xs text-purple-800 font-medium">
                  {displayIg(row.customer)} asked to keep this as credit. Nothing has moved yet — it waits here until
                  one of their orders can take it.
                </div>
              )}
              <div className="text-xs text-purple-700">
                Move up to <span className="font-bold">{formatRp(row.refundAmount)}</span> of overpayment credit to
                another order for <span className="font-medium">{displayIg(row.customer)}</span>. No cash moves — it
                leaves this order and counts as payment on the chosen one.
              </div>
              {customerEvents.filter((ev) => ev.eventId !== row.event).length === 0 ? (
                <p className="text-xs text-purple-600">
                  This customer has no other orders to credit. Create their next order first, then apply the credit.
                </p>
              ) : (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-purple-800">Target order (event)</span>
                    <select
                      value={creditTarget}
                      onChange={(e) => {
                        const id = e.target.value
                        setCreditTarget(id)
                        // Default the amount to what the target owes, capped at
                        // the overpayment — so the common case fully settles the
                        // target without over-crediting it.
                        const tgt = customerEvents.find((ev) => ev.eventId === id)
                        const owed = Math.max(0, tgt?.invoice.sisaPelunasan ?? 0)
                        setCreditAmount(id ? String(Math.min(row.refundAmount, owed) || row.refundAmount) : "")
                      }}
                      disabled={saving}
                      className={`${INPUT_CLASS} w-full`}
                    >
                      <option value="">Select an order…</option>
                      {customerEvents
                        .filter((ev) => ev.eventId !== row.event)
                        .map((ev) => {
                          const owed = Math.max(0, ev.invoice.sisaPelunasan)
                          return (
                            <option key={ev.eventId} value={ev.eventId}>
                              {ev.eventId} — {owed > 0 ? `owes ${formatRp(owed)}` : "fully paid"}
                            </option>
                          )
                        })}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-purple-800">Amount to apply (max {formatRp(row.refundAmount)})</span>
                    <input
                      type="number"
                      min="1"
                      max={row.refundAmount}
                      value={creditAmount}
                      onChange={(e) => setCreditAmount(e.target.value)}
                      disabled={saving || !creditTarget}
                      className={`${INPUT_CLASS} w-full`}
                    />
                  </label>
                  {(() => {
                    // Warn (but don't block) when the chosen amount exceeds what
                    // the target owes: the excess resurfaces as a fresh
                    // overpayment on that order rather than fully clearing.
                    const tgt = customerEvents.find((ev) => ev.eventId === creditTarget)
                    const amt = Math.round(Number(creditAmount)) || 0
                    if (!tgt || amt <= 0) return null
                    const owed = Math.max(0, tgt.invoice.sisaPelunasan)
                    if (amt <= owed) return null
                    const excess = amt - owed
                    return (
                      <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2">
                        ⚠ {formatRp(amt)} is more than {tgt.eventId} owes ({formatRp(owed)}). The extra{" "}
                        <span className="font-semibold">{formatRp(excess)}</span> will resurface as a new overpayment
                        on {tgt.eventId} — no money is lost, but it won't fully clear there.
                      </p>
                    )
                  })()}
                  <div className="flex gap-2">
                    <button
                      onClick={handleApplyCredit}
                      disabled={saving || !creditTarget || !(Math.round(Number(creditAmount)) > 0)}
                      className="px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 disabled:opacity-50 transition-colors"
                    >
                      {saving ? "Applying…" : "Apply Credit"}
                    </button>
                    <button
                      onClick={() => { setShowCredit(false); setCreditTarget(""); setCreditAmount("") }}
                      disabled={saving}
                      className="px-3 py-2 rounded-lg border border-purple-200 text-purple-700 text-sm hover:bg-purple-100 disabled:opacity-50 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
              </div>
              )}
            </div>
          )}
        </div>

        {/* Footer — Delete (when editable) on the left, Cancel + primary CTA right */}
        {error && <p className="shrink-0 text-xs text-red-500 px-6 pb-2">{error}</p>}
        <div className="shrink-0 flex items-center justify-between gap-2 px-6 py-4 border-t border-cream-border">
          {!isReadOnly ? (
            <button
              type="button"
              onClick={handleDelete}
              disabled={saving}
              aria-label="Delete"
              className="inline-flex items-center justify-center h-[38px] border border-cream-border rounded-lg px-3 text-sm text-faint hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" />
              </svg>
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 rounded-lg border border-cream-border text-muted-strong text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            {primaryAction}
          </div>
        </div>
      </div>
    </div>
    {showFullInvoice && (
      // Wrapper raises the drawer (z-40) above this refund modal (z-50).
      <div className="relative z-[60]">
        <InvoiceDetailDrawer customer={row.customer} onClose={() => setShowFullInvoice(false)} />
      </div>
    )}
    </>
  )
}
