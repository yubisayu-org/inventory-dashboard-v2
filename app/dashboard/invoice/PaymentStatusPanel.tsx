"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { displayIg, fmt } from "@/lib/format"
import type { PaymentStatus, PaymentStatusRow } from "@/lib/db"
import EventSelect from "@/components/EventSelect"
import DataGrid, { type ColumnDef } from "@/components/DataGrid"
import CopyInvoiceButton from "@/components/CopyInvoiceButton"
import { AddAdjustmentFromInvoiceModal } from "./AddAdjustmentFromInvoiceModal"

// ─── Payment Status Panel ────────────────────────────────────────────────────

const STATUS_LABELS: Record<PaymentStatus, string> = {
  void: "Void",
  unpaid: "Unpaid",
  partial: "Partial",
  paid: "Paid",
  overpaid: "Overpaid",
}

const STATUS_COLORS: Record<PaymentStatus, string> = {
  void: "bg-gray-100 text-gray-500 border-gray-200",
  unpaid: "bg-red-50 text-red-700 border-red-200",
  partial: "bg-yellow-50 text-yellow-700 border-yellow-200",
  paid: "bg-green-50 text-green-700 border-green-200",
  overpaid: "bg-purple-50 text-purple-700 border-purple-200",
}

type StatusFilter = "all" | PaymentStatus

export function PaymentStatusPanel({
  events,
  onOpenCustomer,
}: {
  events: string[]
  onOpenCustomer: (customer: string) => void
}) {
  const [event, setEvent] = useState<string>("")
  const [rows, setRows] = useState<PaymentStatusRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>("all")
  const [adjustingRow, setAdjustingRow] = useState<{ event: string; customer: string } | null>(null)

  // Fetch every event's payment status once; the event picker filters client-side.
  const fetchRows = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/sheets/invoice/payment-status`, { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to load")
      setRows(data.rows ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchRows() }, [fetchRows])

  // Rows scoped to the selected event (or all events when none is picked).
  const eventRows = useMemo(
    () => (event ? rows.filter((r) => r.event === event) : rows),
    [rows, event],
  )

  const counts = useMemo(() => {
    const c: Record<PaymentStatus, number> = { void: 0, unpaid: 0, partial: 0, paid: 0, overpaid: 0 }
    for (const r of eventRows) c[r.status]++
    return c
  }, [eventRows])

  const totals = useMemo(() => {
    // Outstanding = money customers still owe (positive balances); overpaid =
    // money owed back to customers (negative balances), shown as a magnitude.
    let outstanding = 0
    let overpaid = 0
    for (const r of eventRows) {
      if (r.outstanding > 0) outstanding += r.outstanding
      else if (r.outstanding < 0) overpaid += -r.outstanding
    }
    return { outstanding, overpaid }
  }, [eventRows])

  // The status chips pre-filter the rows fed to the grid; the grid then handles
  // search, per-column filters, sorting and pagination — same as other tables.
  const gridRows = useMemo(
    () => (filter === "all" ? eventRows : eventRows.filter((r) => r.status === filter)),
    [eventRows, filter],
  )

  const columns = useMemo<ColumnDef<PaymentStatusRow, unknown>[]>(() => [
    {
      accessorKey: "event",
      header: "Event",
      filterFn: "textContains",
      cell: ({ getValue }) => <span className="text-gray-500 whitespace-nowrap">{getValue<string>()}</span>,
    },
    {
      accessorKey: "customer",
      header: "Customer",
      filterFn: "textContains",
      cell: ({ row }) => (
        <button
          type="button"
          onClick={() => onOpenCustomer(row.original.customer)}
          className="font-medium text-foreground hover:text-brand transition-colors text-left"
        >
          {displayIg(row.original.customer)}
        </button>
      ),
    },
    {
      accessorKey: "invoiceTotal",
      header: "Invoice Total",
      filterFn: "numeric",
      meta: { align: "right" },
      cell: ({ getValue }) => <span className="tabular-nums">Rp {fmt(getValue<number>())}</span>,
    },
    {
      accessorKey: "totalPaid",
      header: "Paid",
      filterFn: "numeric",
      meta: { align: "right" },
      cell: ({ getValue }) => <span className="tabular-nums">Rp {fmt(getValue<number>())}</span>,
    },
    {
      accessorKey: "outstanding",
      header: "Outstanding",
      filterFn: "numeric",
      meta: { align: "right" },
      cell: ({ getValue }) => {
        const v = getValue<number>()
        return (
          <span className={`tabular-nums font-medium ${v > 0 ? "text-red-600" : v < 0 ? "text-purple-600" : "text-green-600"}`}>
            {v > 0 ? "Rp " + fmt(v) : v < 0 ? "−Rp " + fmt(Math.abs(v)) : "—"}
          </span>
        )
      },
    },
    {
      accessorKey: "status",
      header: "Status",
      enableColumnFilter: false,
      cell: ({ getValue }) => {
        const s = getValue<PaymentStatus>()
        return (
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_COLORS[s]}`}>
            {STATUS_LABELS[s]}
          </span>
        )
      },
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableColumnFilter: false,
      size: 72,
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <CopyInvoiceButton customer={row.original.customer} event={row.original.event} />
          <button
            type="button"
            onClick={() => setAdjustingRow({ event: row.original.event, customer: row.original.customer })}
            title="Add adjustment for this invoice"
            className="text-gray-400 hover:text-brand transition-colors p-1 rounded"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
      ),
    },
  ], [onOpenCustomer])

  const filters: { key: StatusFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: eventRows.length },
    { key: "unpaid", label: "Unpaid", count: counts.unpaid },
    { key: "partial", label: "Partial", count: counts.partial },
    { key: "paid", label: "Paid", count: counts.paid },
    { key: "overpaid", label: "Overpaid", count: counts.overpaid },
    { key: "void", label: "Void", count: counts.void },
  ]

  const renderMobileCard = useCallback((r: PaymentStatusRow) => (
    <div className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => onOpenCustomer(r.customer)}
          className="font-semibold text-sm text-foreground hover:text-brand transition-colors text-left min-w-0 truncate"
        >
          {displayIg(r.customer)}
        </button>
        <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${STATUS_COLORS[r.status]}`}>
          {STATUS_LABELS[r.status]}
        </span>
      </div>
      <div className="text-xs text-gray-400 mt-0.5">{r.event}</div>

      <div className="mt-2.5 pt-2.5 border-t border-cream-border flex flex-col gap-1 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Invoice</span>
          <span className="tabular-nums text-foreground">Rp {fmt(r.invoiceTotal)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Paid</span>
          <span className="tabular-nums text-foreground">Rp {fmt(r.totalPaid)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Outstanding</span>
          <span className={`tabular-nums font-medium ${r.outstanding > 0 ? "text-red-600" : r.outstanding < 0 ? "text-purple-600" : "text-green-600"}`}>
            {r.outstanding > 0 ? "Rp " + fmt(r.outstanding) : r.outstanding < 0 ? "−Rp " + fmt(Math.abs(r.outstanding)) : "—"}
          </span>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-end gap-1">
        <CopyInvoiceButton customer={r.customer} event={r.event} />
        <button
          type="button"
          onClick={() => setAdjustingRow({ event: r.event, customer: r.customer })}
          title="Add adjustment for this invoice"
          className="text-gray-400 hover:text-brand transition-colors p-1 rounded"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    </div>
  ), [onOpenCustomer])

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar: event filter + refresh */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="w-full sm:w-48">
          <EventSelect value={event} onChange={setEvent} events={events} placeholder="All events" clearable />
        </div>
        <button
          type="button"
          onClick={fetchRows}
          title="Refresh"
          className="p-1.5 text-gray-400 hover:text-brand transition-colors rounded"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-6.22-8.56" /><polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
      </div>

      {/* Status filter chips */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {filters.map((f) => {
          const active = filter === f.key
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                active
                  ? "bg-brand text-white border-brand"
                  : "bg-white text-gray-600 border-cream-border hover:border-brand hover:text-brand"
              }`}
            >
              {f.label}
              {f.count > 0 && (
                <span className={`ml-1.5 text-[10px] ${active ? "text-white/80" : "text-gray-400"}`}>
                  {f.count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Summary */}
      {eventRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-gray-500 px-1">
          <div>
            <span className="text-gray-400">Outstanding:</span>{" "}
            <span className="font-medium tabular-nums text-red-600">Rp {fmt(totals.outstanding)}</span>
          </div>
          <div>
            <span className="text-gray-400">Overpaid:</span>{" "}
            <span className="font-medium tabular-nums text-purple-600">Rp {fmt(totals.overpaid)}</span>
          </div>
        </div>
      )}

      {/* Table (desktop) / cards (mobile) */}
      {loading ? (
        <div className="rounded-xl border border-cream-border bg-white py-12 text-center text-sm text-gray-400">Loading…</div>
      ) : error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 py-8 px-4 text-sm text-red-500">{error}</div>
      ) : (
        <DataGrid
          key={`${event}-${filter}`}
          data={gridRows}
          columns={columns}
          getRowId={(r) => `${r.event}-${r.customer}`}
          searchPlaceholder="Search customers, events…"
          pageSize={50}
          initialSorting={[{ id: "outstanding", desc: true }]}
          renderMobileCard={renderMobileCard}
        />
      )}

      {adjustingRow && (
        <AddAdjustmentFromInvoiceModal
          event={adjustingRow.event}
          customer={adjustingRow.customer}
          onClose={() => setAdjustingRow(null)}
          onSaved={fetchRows}
        />
      )}
    </div>
  )
}
