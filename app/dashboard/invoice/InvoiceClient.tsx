"use client"

import { displayIg, fmt } from "@/lib/format"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { CustomerDetail, InvoiceEvent, InvoiceOrderLine, InvoiceResult, PaymentStatus, PaymentStatusRow, RefundReason } from "@/lib/db"
import { useCopyFeedback } from "@/hooks/useCopyFeedback"
import { useResizableColumns } from "@/hooks/useResizableColumns"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import SearchableSelect from "@/components/SearchableSelect"

export default function InvoiceClient() {
  const options = useSheetOptions()
  const [selectedCustomer, setSelectedCustomer] = useState<string | null>(null)

  return (
    <div className="max-w-6xl">
      <PaymentStatusPanel
        events={options?.events ?? []}
        customers={options?.customers ?? []}
        onOpenCustomer={setSelectedCustomer}
      />
      {selectedCustomer && (
        <InvoiceDetailDrawer
          customer={selectedCustomer}
          onClose={() => setSelectedCustomer(null)}
        />
      )}
    </div>
  )
}

// ─── Invoice Detail Drawer ───────────────────────────────────────────────────

function InvoiceDetailDrawer({
  customer,
  onClose,
}: {
  customer: string
  onClose: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<InvoiceResult | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setResult(null)
    fetch(`/api/sheets/invoice?customer=${encodeURIComponent(customer)}`, { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to load")
        return data as InvoiceResult
      })
      .then((data) => { if (!cancelled) setResult(data) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load") })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [customer])

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30 transition-opacity" />
      <div
        className="relative w-full max-w-3xl h-full bg-cream shadow-2xl border-l border-cream-border flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-cream-border bg-white shrink-0 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground truncate">
              {displayIg(result?.customer || customer)}
            </div>
            {result && (
              <div className="text-xs text-gray-400 mt-0.5">
                {result.events.length} event{result.events.length === 1 ? "" : "s"}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-foreground transition-colors p-1 rounded shrink-0"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-gray-400 text-sm">
              Loading invoice…
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {!loading && !error && result && result.events.length === 0 && (
            <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-gray-400 text-sm">
              No orders found for &quot;{customer}&quot;.
            </div>
          )}

          {result && result.events.length > 0 && (
            <div className="flex flex-col gap-4">
              {[...result.events].reverse().map((ev) => (
                <EventCard
                  key={ev.eventId}
                  event={ev}
                  customer={result.customer}
                  customerDetail={result.customerDetail}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Payment Status Panel ────────────────────────────────────────────────────

const STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: "Unpaid",
  partial: "Partial",
  paid: "Paid",
  overpaid: "Overpaid",
}

const STATUS_COLORS: Record<PaymentStatus, string> = {
  unpaid: "bg-red-50 text-red-700 border-red-200",
  partial: "bg-yellow-50 text-yellow-700 border-yellow-200",
  paid: "bg-green-50 text-green-700 border-green-200",
  overpaid: "bg-purple-50 text-purple-700 border-purple-200",
}

type StatusFilter = "all" | PaymentStatus
type SortKey = "customer" | "invoiceTotal" | "totalPaid" | "outstanding" | "status"
type SortDir = "asc" | "desc"

const STATUS_RANK: Record<PaymentStatus, number> = {
  unpaid: 0,
  overpaid: 1,
  partial: 2,
  paid: 3,
}

function SortableHeader({
  sortKey,
  currentKey,
  dir,
  onClick,
  align,
  widthClass,
  children,
}: {
  sortKey: SortKey
  currentKey: SortKey
  dir: SortDir
  onClick: (key: SortKey) => void
  align: "left" | "right"
  widthClass?: string
  children: React.ReactNode
}) {
  const active = currentKey === sortKey
  return (
    <th className={`px-4 py-2.5 font-medium text-gray-500 ${align === "right" ? "text-right" : "text-left"} ${widthClass ?? ""}`}>
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={`group inline-flex items-center gap-1 ${align === "right" ? "ml-auto" : ""} transition-colors ${active ? "text-brand" : "hover:text-foreground"}`}
      >
        {children}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-opacity ${active ? "opacity-100" : "opacity-0 group-hover:opacity-60"}`}
        >
          {active && dir === "asc" ? (
            <path d="m18 15-6-6-6 6" />
          ) : (
            <path d="m6 9 6 6 6-6" />
          )}
        </svg>
      </button>
    </th>
  )
}

function PaymentStatusPanel({
  events,
  customers,
  onOpenCustomer,
}: {
  events: string[]
  customers: string[]
  onOpenCustomer: (customer: string) => void
}) {
  const [event, setEvent] = useState<string>("")
  const [rows, setRows] = useState<PaymentStatusRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState<StatusFilter>("all")
  const [sortKey, setSortKey] = useState<SortKey>("outstanding")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir(key === "customer" ? "asc" : "desc")
    }
  }

  // Default the event to the most recent (lexicographically last; events like "LSCN202601" sort chronologically)
  useEffect(() => {
    if (!event && events.length > 0) {
      const sorted = [...events].sort()
      setEvent(sorted[sorted.length - 1])
    }
  }, [events, event])

  const fetchRows = useCallback(async (ev: string) => {
    if (!ev) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/sheets/invoice/payment-status?event=${encodeURIComponent(ev)}`, { cache: "no-store" })
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

  useEffect(() => {
    if (event) fetchRows(event)
  }, [event, fetchRows])

  const counts = useMemo(() => {
    const c: Record<PaymentStatus, number> = { unpaid: 0, partial: 0, paid: 0, overpaid: 0 }
    for (const r of rows) c[r.status]++
    return c
  }, [rows])

  const totals = useMemo(() => {
    const invoiceTotal = rows.reduce((s, r) => s + r.invoiceTotal, 0)
    const paidTotal = rows.reduce((s, r) => s + r.totalPaid, 0)
    return { invoiceTotal, paidTotal, outstanding: invoiceTotal - paidTotal }
  }, [rows])

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (filter !== "all" && r.status !== filter) return false
      if (q && !r.customer.toLowerCase().includes(q)) return false
      return true
    })
  }, [rows, search, filter])

  const sortedRows = useMemo(() => {
    const arr = [...filteredRows]
    arr.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case "customer":
          cmp = a.customer.localeCompare(b.customer)
          break
        case "invoiceTotal":
          cmp = a.invoiceTotal - b.invoiceTotal
          break
        case "totalPaid":
          cmp = a.totalPaid - b.totalPaid
          break
        case "outstanding":
          cmp = a.outstanding - b.outstanding
          break
        case "status":
          cmp = STATUS_RANK[a.status] - STATUS_RANK[b.status]
          if (cmp === 0) cmp = b.outstanding - a.outstanding
          break
      }
      return sortDir === "asc" ? cmp : -cmp
    })
    return arr
  }, [filteredRows, sortKey, sortDir])

  const filters: { key: StatusFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: rows.length },
    { key: "unpaid", label: "Unpaid", count: counts.unpaid },
    { key: "partial", label: "Partial", count: counts.partial },
    { key: "paid", label: "Paid", count: counts.paid },
    { key: "overpaid", label: "Overpaid", count: counts.overpaid },
  ]

  const customerLookupOptions = useMemo(
    () => customers.map((c) => ({ value: c, label: c })),
    [customers],
  )

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar: event + search + lookup + refresh */}
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={event}
          onChange={(e) => setEvent(e.target.value)}
          className="border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
          style={{ width: "12rem" }}
        >
          {events.length === 0 && <option value="">No events</option>}
          {events.map((ev) => (
            <option key={ev} value={ev}>{ev}</option>
          ))}
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter customers in this event…"
          className="flex-1 min-w-[180px] border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
        />
        <div className="w-56">
          <SearchableSelect
            value=""
            onChange={(v) => { if (v.trim()) onOpenCustomer(v.trim()) }}
            options={customerLookupOptions}
            placeholder="Look up any customer…"
            allowNewValue
          />
        </div>
        <button
          type="button"
          onClick={() => fetchRows(event)}
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
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-gray-500 px-1">
          <div>
            <span className="text-gray-400">Invoice total:</span>{" "}
            <span className="text-foreground font-medium tabular-nums">Rp {fmt(totals.invoiceTotal)}</span>
          </div>
          <div>
            <span className="text-gray-400">Paid:</span>{" "}
            <span className="text-foreground font-medium tabular-nums">Rp {fmt(totals.paidTotal)}</span>
          </div>
          <div>
            <span className="text-gray-400">Outstanding:</span>{" "}
            <span className={`font-medium tabular-nums ${totals.outstanding > 0 ? "text-red-600" : totals.outstanding < 0 ? "text-purple-600" : "text-green-600"}`}>
              Rp {fmt(totals.outstanding)}
            </span>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
        {loading ? (
          <div className="py-12 text-center text-sm text-gray-400">Loading…</div>
        ) : error ? (
          <div className="py-8 px-4 text-sm text-red-500">{error}</div>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-cream-border bg-gray-50/80">
                <SortableHeader sortKey="customer" currentKey={sortKey} dir={sortDir} onClick={toggleSort} align="left">
                  Customer
                </SortableHeader>
                <SortableHeader sortKey="invoiceTotal" currentKey={sortKey} dir={sortDir} onClick={toggleSort} align="right" widthClass="w-36">
                  Invoice Total
                </SortableHeader>
                <SortableHeader sortKey="totalPaid" currentKey={sortKey} dir={sortDir} onClick={toggleSort} align="right" widthClass="w-32">
                  Paid
                </SortableHeader>
                <SortableHeader sortKey="outstanding" currentKey={sortKey} dir={sortDir} onClick={toggleSort} align="right" widthClass="w-32">
                  Outstanding
                </SortableHeader>
                <SortableHeader sortKey="status" currentKey={sortKey} dir={sortDir} onClick={toggleSort} align="left" widthClass="w-28">
                  Status
                </SortableHeader>
              </tr>
            </thead>
            <tbody>
              {sortedRows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-sm text-gray-400">
                    {rows.length === 0 ? "No customers for this event" : "No matches"}
                  </td>
                </tr>
              ) : sortedRows.map((r) => (
                <tr
                  key={r.customer}
                  className="border-b border-cream-border hover:bg-gray-50/50 transition-colors cursor-pointer"
                  onClick={() => onOpenCustomer(r.customer)}
                >
                  <td className="px-4 py-2.5 font-medium text-foreground">{displayIg(r.customer)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-foreground">
                    Rp {fmt(r.invoiceTotal)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-foreground">
                    Rp {fmt(r.totalPaid)}
                  </td>
                  <td className={`px-4 py-2.5 text-right tabular-nums font-medium ${r.outstanding > 0 ? "text-red-600" : r.outstanding < 0 ? "text-purple-600" : "text-green-600"}`}>
                    {r.outstanding > 0 ? "Rp " + fmt(r.outstanding) : r.outstanding < 0 ? "−Rp " + fmt(Math.abs(r.outstanding)) : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_COLORS[r.status]}`}>
                      {STATUS_LABELS[r.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function CustomerInfoModal({
  customer,
  detail,
  onClose,
}: {
  customer: string
  detail: CustomerDetail
  onClose: () => void
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-3 border-b border-cream-border flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">{displayIg(customer).toUpperCase()}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-foreground transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-4 flex flex-col gap-3 text-sm">
          {detail.whatsapp && (
            <div>
              <div className="text-xs font-medium text-gray-500 mb-0.5">WhatsApp</div>
              <div className="text-foreground">{detail.whatsapp}</div>
            </div>
          )}
          {detail.dataDiri && (
            <div>
              <div className="text-xs font-medium text-gray-500 mb-0.5">Data Diri</div>
              <pre className="whitespace-pre-wrap font-sans text-foreground leading-relaxed">{detail.dataDiri}</pre>
            </div>
          )}
          {detail.ekspedisi && (
            <div>
              <div className="text-xs font-medium text-gray-500 mb-0.5">Ekspedisi</div>
              <div className="text-foreground">{detail.ekspedisi}</div>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-cream-border flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function EventCard({
  event,
  customer,
  customerDetail,
}: {
  event: InvoiceEvent
  customer: string
  customerDetail: CustomerDetail | null
}) {
  const [infoOpen, setInfoOpen] = useState(false)
  const [refundLine, setRefundLine] = useState<InvoiceOrderLine | null>(null)
  const { eta, status, shipments, showShipments, orders, totals } = event
  const { widths, startResize } = useResizableColumns({ order: 220, unit: 60, price: 100, subtotal: 100, ready: 60, refund: 32 })
  const shipmentCount = shipments.length

  return (
    <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 bg-cream border-b border-cream-border">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-foreground">{displayIg(customer).toUpperCase()}</span>
            {customerDetail && (
              <button
                type="button"
                onClick={() => setInfoOpen(true)}
                aria-label="Customer info"
                className="text-gray-400 hover:text-brand transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              </button>
            )}
          </div>
          {infoOpen && customerDetail && (
            <CustomerInfoModal customer={customer} detail={customerDetail} onClose={() => setInfoOpen(false)} />
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
            <span className="font-medium">{event.eventId}</span>
            {eta && <span className="text-gray-500">• {eta}</span>}
          </div>
          {status && (
            <div className="text-xs text-gray-500">
              <span className="font-medium text-foreground">Status:</span> {status}
            </div>
          )}
          {showShipments &&
            shipments.map((s, i) => (
              <div key={i} className="text-xs text-gray-500">
                <span className="font-medium text-foreground">
                  Resi{shipmentCount > 1 ? ` ${i + 1}/${shipmentCount}` : ""}:
                </span>{" "}
                <span className="font-mono">{s.resi}</span>
                {s.tanggalKirim && <span className="ml-2">({s.tanggalKirim})</span>}
              </div>
            ))}
        </div>
      </div>

      {/* Orders table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-cream-border">
              <th className="px-4 py-2 font-medium relative select-none" style={{ width: widths.order }}>
                Order
                <div onMouseDown={(e) => startResize("order", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.unit }}>
                Unit
                <div onMouseDown={(e) => startResize("unit", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.price }}>
                Price
                <div onMouseDown={(e) => startResize("price", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.subtotal }}>
                Subtotal
                <div onMouseDown={(e) => startResize("subtotal", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.ready }}>
                Ready
                <div onMouseDown={(e) => startResize("ready", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-2 py-2" style={{ width: widths.refund }} />
            </tr>
          </thead>
          <tbody>
            {[...orders].reverse().map((r, i) => (
              <tr key={i} className="border-b border-cream-border/60 group">
                <td className="px-4 py-2">{r.order}</td>
                <td className="px-4 py-2 text-right">{r.unit}</td>
                <td className="px-4 py-2 text-right">{r.price}</td>
                <td className="px-4 py-2 text-right">{r.subtotal}</td>
                <td className="px-4 py-2 text-right">{r.unitArrive}</td>
                <td className="px-2 py-2 text-center">
                  <button
                    type="button"
                    onClick={() => setRefundLine(r)}
                    title="Create refund for this line"
                    className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-all"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                      <path d="M3 3v5h5" />
                    </svg>
                  </button>
                </td>
              </tr>
            ))}
            <tr className="font-semibold bg-cream/40">
              <td className="px-4 py-2">Total</td>
              <td className="px-4 py-2 text-right">{totals.unit}</td>
              <td className="px-4 py-2"></td>
              <td className="px-4 py-2 text-right">{fmt(totals.subtotal)}</td>
              <td className="px-4 py-2 text-right">{totals.arrive}</td>
              <td className="px-2 py-2" />
            </tr>
          </tbody>
        </table>
      </div>

      {/* Invoice summary */}
      <InvoiceSummary event={event} />

      {/* Refund modal — triggered per order line */}
      {refundLine && (
        <RefundFromInvoiceModal
          line={refundLine}
          event={event.eventId}
          customer={customer}
          onClose={() => setRefundLine(null)}
        />
      )}
    </div>
  )
}



function InvoiceMessageActions({ event }: { event: InvoiceEvent }) {
  const [open, setOpen] = useState(false)
  const { copied, copy } = useCopyFeedback()
  const { message } = event

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
      >
        View message
      </button>
      <button
        type="button"
        onClick={() => copy(message)}
        className="shrink-0 px-3 py-1.5 rounded-lg border border-brand text-brand text-xs font-medium hover:bg-brand hover:text-white transition-colors"
      >
        {copied ? "Copied!" : "Copy message"}
      </button>
      {open && (
        <InvoiceMessageModal
          message={message}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

function InvoiceMessageModal({
  message,
  onClose,
}: {
  message: string
  onClose: () => void
}) {
  const { copied, copy } = useCopyFeedback()

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-3 border-b border-cream-border flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">Invoice message</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-foreground transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <pre className="px-5 py-4 overflow-auto text-sm text-foreground whitespace-pre-wrap font-sans flex-1">
          {message}
        </pre>
        <div className="px-5 py-3 border-t border-cream-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => copy(message)}
            className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
          >
            {copied ? "Copied!" : "Copy message"}
          </button>
        </div>
      </div>
    </div>
  )
}

function InvoiceSummary({ event }: { event: InvoiceEvent }) {
  const { invoice, totals } = event
  const { subtotalBarang, estimasiOngkir, biayaLainnya, total, pembayaran, sisaPelunasan } =
    invoice

  const sisaAbs = Math.abs(sisaPelunasan)
  const isRefund = sisaPelunasan < 0
  const sisaLabel = isRefund ? "Pengembalian Dana" : "Sisa Pelunasan"
  const sisaColor = sisaPelunasan <= 0 ? "text-green-700" : "text-red-600"

  return (
    <div className="px-5 py-4 bg-cream/30 border-t border-cream-border">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div className="text-sm font-semibold text-foreground">Invoice</div>
        <InvoiceMessageActions event={event} />
      </div>
      <dl className="text-sm">
        <Row label="Subtotal Barang" value={`Rp ${fmt(subtotalBarang)}`} />
        <Row label="Estimasi Berat" value={`${fmt(totals.weightKg)} kg`} />
        <Row label="Estimasi Ongkos Kirim" value={`Rp ${fmt(estimasiOngkir)}`} />
        {biayaLainnya > 0 && (
          <Row label="Diskon" value={`- Rp ${fmt(biayaLainnya)}`} />
        )}
        {biayaLainnya < 0 && (
          <Row label="Biaya Lainnya" value={`+ Rp ${fmt(Math.abs(biayaLainnya))}`} />
        )}
        {total > 0 && (
          <Row
            label="Total"
            value={`Rp ${fmt(total)}`}
            strong
            separator
          />
        )}
        <Row label="Pembayaran" value={`Rp ${fmt(pembayaran)}`} />
        <Row label={sisaLabel} value={`Rp ${fmt(sisaAbs)}`} valueClassName={sisaColor} />
      </dl>
    </div>
  )
}

// ─── Refund from invoice modal ───────────────────────────────────────────────

const REASON_LABELS: Record<RefundReason, string> = {
  overpayment: "Overpayment",
  unavailable: "Item Unavailable",
  shipping_loss: "Lost in Shipping",
  damaged: "Damaged",
  goodwill: "Goodwill",
  other: "Other",
}

const INPUT_CLASS =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

function RefundFromInvoiceModal({
  line,
  event,
  customer,
  onClose,
}: {
  line: InvoiceOrderLine
  event: string
  customer: string
  onClose: () => void
}) {
  // Resolve unit price: use raw if valid, otherwise parse the formatted string ("390.000" → 390000)
  const unitPrice =
    Number(line.rawUnitPrice) > 0
      ? Number(line.rawUnitPrice)
      : Number(String(line.price ?? "").replace(/\D/g, "")) || 0

  const unfulfilledUnits = Math.max(0, line.unit - line.unitArrive)
  const defaultReason: RefundReason = unfulfilledUnits > 0 ? "shipping_loss" : "other"

  const [reason, setReason] = useState<RefundReason>(defaultReason)
  const [affectedUnits, setAffectedUnits] = useState(String(line.unit))
  const [refundAmount, setRefundAmount] = useState(String(line.unit * unitPrice))
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  function handleAffectedUnitsChange(val: string) {
    setAffectedUnits(val)
    const n = Number(val)
    if (Number.isFinite(n)) {
      setRefundAmount(String(n * unitPrice))
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event,
          customer,
          reason,
          refundAmount: Number(refundAmount),
          orderId: line.orderId,
          affectedUnits: Number(affectedUnits),
          note: note.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to create")
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <form
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-sm flex flex-col gap-4 p-6"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Create Refund</div>
            <div className="text-xs text-gray-400 mt-0.5">
              {line.productName || (line.order ?? "").replace(/ x \d+$/, "")} × {line.unit}
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-brand transition-colors shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {done ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
              <circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" />
            </svg>
            <p className="text-sm font-medium text-foreground">Refund created</p>
            <p className="text-xs text-gray-400">Track it on the Refunds page</p>
            <button type="button" onClick={onClose} className="mt-1 px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 transition-colors">
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Reason</span>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value as RefundReason)}
                  disabled={saving}
                  className={INPUT_CLASS}
                >
                  {(Object.entries(REASON_LABELS) as [RefundReason, string][]).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">
                  Affected units <span className="text-gray-400 font-normal">(of {line.unit} ordered, {line.unitArrive} arrived)</span>
                </span>
                <input
                  type="number"
                  min="1"
                  max={line.unit}
                  value={affectedUnits}
                  onChange={(e) => handleAffectedUnitsChange(e.target.value)}
                  disabled={saving}
                  className={INPUT_CLASS}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Refund amount (Rp)</span>
                <input
                  type="number"
                  min="1"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                  disabled={saving}
                  className={INPUT_CLASS}
                />
                <span className="text-xs text-gray-400">
                  {Number(affectedUnits)} × Rp {fmt(unitPrice)}
                </span>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Note <span className="text-gray-400 font-normal">(optional)</span></span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={saving}
                  rows={2}
                  placeholder="e.g. Lost during international transit"
                  className={`${INPUT_CLASS} resize-none`}
                />
              </label>
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={saving || Number(refundAmount) < 1} className="px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 disabled:opacity-50 transition-colors">
                {saving ? "Creating…" : "Create Refund"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}

function Row({
  label,
  value,
  strong,
  separator,
  valueClassName,
}: {
  label: string
  value: string
  strong?: boolean
  separator?: boolean
  valueClassName?: string
}) {
  return (
    <div
      className={`flex justify-between py-1 ${
        separator ? "border-t border-cream-border mt-1 pt-2" : ""
      } ${strong ? "font-semibold" : ""}`}
    >
      <dt className="text-gray-600">{label}</dt>
      <dd className={valueClassName ?? "text-foreground"}>{value}</dd>
    </div>
  )
}
