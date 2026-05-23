"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { displayIg, fmt } from "@/lib/format"
import type { PaymentStatus, PaymentStatusRow } from "@/lib/db"
import SearchableSelect from "@/components/SearchableSelect"

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

export function PaymentStatusPanel({
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
