"use client"

import { useEffect, useState } from "react"
import type { ExcessRow } from "@/lib/db"
import { useResizableColumns } from "@/hooks/useResizableColumns"

const ROWS_PER_PAGE = 20

type UpdatedRow = { rowNumber: number; customer: string; oldUnitBuy: number; unitBuy: number }
type ApplyResult = { filled: UpdatedRow[]; remainder: number }
type BulkItemResult = { event: string; items: string; originalUnitBuy: number; filled: UpdatedRow[]; remainder: number }
type BulkResult = { results: BulkItemResult[] }

export default function ExcessTable() {
  const [rows, setRows] = useState<ExcessRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [busyRow, setBusyRow] = useState<number | null>(null)
  const [pendingRow, setPendingRow] = useState<number | null>(null)
  const [pendingReceipt, setPendingReceipt] = useState("apply excess")
  const [applyResult, setApplyResult] = useState<{ excessRowNumber: number; result: ApplyResult } | null>(null)
  const [bulkPending, setBulkPending] = useState(false)
  const [bulkReceipt, setBulkReceipt] = useState("apply excess")
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null)

  useEffect(() => {
    fetch("/api/sheets/excess-purchase")
      .then((r) => r.json())
      .then((data: { rows?: ExcessRow[]; error?: string }) => {
        if (data.error) throw new Error(data.error)
        setRows(data.rows ?? [])
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false))
  }, [])

  function openPending(rowNumber: number) {
    setPendingRow(rowNumber)
    setPendingReceipt("apply excess")
    setApplyResult(null)
  }

  function cancelPending() {
    setPendingRow(null)
  }

  async function handleBulkApply() {
    setBulkBusy(true)
    setBulkPending(false)
    setBulkResult(null)
    setApplyResult(null)
    try {
      const res = await fetch("/api/sheets/excess-purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receipt: bulkReceipt }),
      })
      const data: BulkResult & { error?: string } = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to apply")

      setBulkResult(data)

      // Sync local state: remove fully consumed, update partially consumed
      setRows((prev) => {
        let updated = [...prev]
        for (const item of data.results) {
          if (item.remainder <= 0) {
            // We don't have the rowNumber here — reload instead
          } else {
            updated = updated.map((r) =>
              r.event === item.event && r.items === item.items && r.unitBuy === item.originalUnitBuy
                ? { ...r, unitBuy: item.remainder }
                : r,
            )
          }
        }
        return updated
      })

      // Reload to get accurate row numbers after deletions
      const fresh = await fetch("/api/sheets/excess-purchase").then((r) => r.json())
      if (!fresh.error) setRows(fresh.rows ?? [])
    } catch (err) {
      setBulkResult({ results: [] })
    } finally {
      setBulkBusy(false)
    }
  }

  async function handleApply(row: ExcessRow) {
    setBusyRow(row.rowNumber)
    setPendingRow(null)
    setApplyResult(null)
    try {
      const res = await fetch(`/api/sheets/excess-purchase/${row.rowNumber}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receipt: pendingReceipt }),
      })
      const data: ApplyResult & { error?: string } = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to apply")

      setApplyResult({ excessRowNumber: row.rowNumber, result: data })

      if (data.remainder <= 0) {
        // Row was fully consumed — remove from local state
        setRows((prev) => prev.filter((r) => r.rowNumber !== row.rowNumber))
      } else {
        // Partially consumed — update unitBuy in local state
        setRows((prev) =>
          prev.map((r) => r.rowNumber === row.rowNumber ? { ...r, unitBuy: data.remainder } : r),
        )
      }
    } catch (err) {
      setApplyResult({
        excessRowNumber: row.rowNumber,
        result: { filled: [], remainder: row.unitBuy },
      })
    } finally {
      setBusyRow(null)
    }
  }

  const { widths, startResize } = useResizableColumns({
    index: 40, event: 120, items: 200, unitBuy: 80,
    receipt: 140, createdAt: 110, updatedAt: 110, action: 90,
  })

  const q = search.trim().toLowerCase()
  const filtered = q
    ? rows.filter(
        (r) =>
          r.event.toLowerCase().includes(q) ||
          r.items.toLowerCase().includes(q) ||
          r.receipt.toLowerCase().includes(q),
      )
    : rows

  const totalPages = Math.max(1, Math.ceil(filtered.length / ROWS_PER_PAGE))
  const currentPage = Math.min(page, totalPages)
  const visible = filtered.slice((currentPage - 1) * ROWS_PER_PAGE, currentPage * ROWS_PER_PAGE)

  function onSearchChange(v: string) {
    setSearch(v)
    setPage(1)
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-gray-400">
        Loading…
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-red-500">
        {error}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search event, item, receipt…"
            className="w-full border border-cream-border rounded-lg pl-8 pr-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
          />
        </div>
        <span className="text-xs text-gray-400 shrink-0">
          {filtered.length} {filtered.length === 1 ? "row" : "rows"}
        </span>

        {/* Bulk apply button */}
        {rows.length > 0 && (
          <button
            type="button"
            onClick={() => { setBulkPending((o) => !o); setBulkReceipt("apply excess"); setBulkResult(null) }}
            disabled={bulkBusy || busyRow !== null}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-brand rounded-lg text-brand hover:bg-brand hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {bulkBusy ? (
              <>
                <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                Applying…
              </>
            ) : bulkPending ? "Cancel" : "Apply All Excess"}
          </button>
        )}
      </div>

      {/* Bulk pending form */}
      {bulkPending && (
        <div className="rounded-xl border border-brand/30 bg-brand/5 px-4 py-3 flex items-center gap-3 flex-wrap">
          <span className="text-xs text-gray-600 shrink-0">
            Apply all <strong>{rows.length}</strong> excess rows to pending orders
          </span>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <label className="text-xs text-gray-500 shrink-0">Receipt</label>
            <input
              type="text"
              value={bulkReceipt}
              onChange={(e) => setBulkReceipt(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleBulkApply()
                if (e.key === "Escape") setBulkPending(false)
              }}
              className="flex-1 max-w-xs border border-cream-border rounded-md px-2.5 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
            />
          </div>
          <button
            type="button"
            onClick={handleBulkApply}
            className="px-3 py-1 text-xs font-medium rounded-md bg-brand text-white hover:bg-brand-hover transition-colors shrink-0"
          >
            Confirm
          </button>
        </div>
      )}

      {/* Bulk result banner */}
      {bulkResult && (
        <BulkResultBanner results={bulkResult.results} onDismiss={() => setBulkResult(null)} />
      )}

      {/* Apply result banner */}
      {applyResult && (
        <ApplyResultBanner
          result={applyResult.result}
          onDismiss={() => setApplyResult(null)}
        />
      )}

      {/* Table */}
      <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
        {filtered.length === 0 ? (
          <p className="px-5 py-8 text-sm text-gray-400 text-center">
            {search ? "No rows match your search." : "No excess purchase records yet."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
              <thead>
                <tr className="border-b border-cream-border text-left bg-cream">
                  <th className="px-4 py-3 text-xs font-medium text-gray-500 relative select-none" style={{ width: widths.index }}>
                    #
                    <div onMouseDown={(e) => startResize("index", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-gray-500 relative select-none" style={{ width: widths.event }}>
                    Event
                    <div onMouseDown={(e) => startResize("event", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-gray-500 relative select-none" style={{ width: widths.items }}>
                    Item
                    <div onMouseDown={(e) => startResize("items", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-gray-500 text-right relative select-none" style={{ width: widths.unitBuy }}>
                    Unit Buy
                    <div onMouseDown={(e) => startResize("unitBuy", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-gray-500 relative select-none" style={{ width: widths.receipt }}>
                    Receipt
                    <div onMouseDown={(e) => startResize("receipt", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-gray-500 relative select-none" style={{ width: widths.createdAt }}>
                    Created At
                    <div onMouseDown={(e) => startResize("createdAt", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-gray-500 relative select-none" style={{ width: widths.updatedAt }}>
                    Updated At
                    <div onMouseDown={(e) => startResize("updatedAt", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                  <th className="px-4 py-3 relative select-none" style={{ width: widths.action }}>
                    <div onMouseDown={(e) => startResize("action", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row, i) => {
                  const busy = busyRow === row.rowNumber
                  const isPending = pendingRow === row.rowNumber
                  return (
                    <>
                      <tr
                        key={row.rowNumber}
                        className="border-b border-cream-border last:border-0 hover:bg-cream/50 transition-colors"
                      >
                        <td className="px-4 py-3 text-xs text-gray-400">
                          {(currentPage - 1) * ROWS_PER_PAGE + i + 1}
                        </td>
                        <td className="px-4 py-3 text-foreground">{row.event}</td>
                        <td className="px-4 py-3 text-foreground">{row.items}</td>
                        <td className="px-4 py-3 text-foreground text-right font-medium tabular-nums">
                          {row.unitBuy}
                        </td>
                        <td className="px-4 py-3 text-gray-500">{row.receipt || "—"}</td>
                        <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{row.createdAt}</td>
                        <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{row.updatedAt || "—"}</td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => isPending ? cancelPending() : openPending(row.rowNumber)}
                            disabled={busy || busyRow !== null}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-brand text-white hover:bg-brand-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {busy ? (
                              <>
                                <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                                </svg>
                                Applying…
                              </>
                            ) : isPending ? "Cancel" : "Apply"}
                          </button>
                        </td>
                      </tr>
                      {isPending && (
                        <tr key={`${row.rowNumber}-pending`} className="border-b border-cream-border bg-cream/40">
                          <td colSpan={8} className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <label className="text-xs text-gray-500 shrink-0">Receipt</label>
                              <input
                                type="text"
                                value={pendingReceipt}
                                onChange={(e) => setPendingReceipt(e.target.value)}
                                className="flex-1 max-w-xs border border-cream-border rounded-md px-2.5 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleApply(row)
                                  if (e.key === "Escape") cancelPending()
                                }}
                              />
                              <button
                                type="button"
                                onClick={() => handleApply(row)}
                                className="px-3 py-1 text-xs font-medium rounded-md bg-brand text-white hover:bg-brand-hover transition-colors"
                              >
                                Confirm
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            className="px-3 py-1.5 text-xs border border-cream-border rounded-lg text-gray-600 hover:bg-cream disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Previous
          </button>
          <span className="text-xs text-gray-400">
            Page {currentPage} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
            className="px-3 py-1.5 text-xs border border-cream-border rounded-lg text-gray-600 hover:bg-cream disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Result banner
// ---------------------------------------------------------------------------

function ApplyResultBanner({
  result,
  onDismiss,
}: {
  result: ApplyResult
  onDismiss: () => void
}) {
  const { filled, remainder } = result
  const noOrders = filled.length === 0

  return (
    <div className={`rounded-xl border overflow-hidden ${noOrders ? "border-gray-200 bg-gray-50" : "border-green-200 bg-green-50"}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-inherit">
        <span className={`text-xs font-medium ${noOrders ? "text-gray-500" : "text-green-700"}`}>
          {noOrders
            ? "No pending orders found for this item and event."
            : `${filled.length} order${filled.length === 1 ? "" : "s"} filled`}
        </span>
        <div className="flex items-center gap-3">
          {remainder > 0 && (
            <span className="text-xs text-yellow-700 bg-yellow-100 border border-yellow-200 rounded-md px-2 py-0.5">
              {remainder} remaining in excess
            </span>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Dismiss"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Filled rows */}
      {filled.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-inherit text-left">
              <th className="px-4 py-2 font-medium text-gray-500 w-8">#</th>
              <th className="px-4 py-2 font-medium text-gray-500">Customer</th>
              <th className="px-4 py-2 font-medium text-gray-500 text-right">Unit Buy</th>
              <th className="px-4 py-2 w-20"></th>
            </tr>
          </thead>
          <tbody>
            {filled.map((row, i) => (
              <tr key={row.rowNumber} className="border-b border-inherit last:border-0">
                <td className="px-4 py-2 text-gray-400">{i + 1}</td>
                <td className="px-4 py-2 text-foreground">{row.customer}</td>
                <td className="px-4 py-2 text-foreground text-right font-semibold tabular-nums">{row.unitBuy}</td>
                <td className="px-4 py-2 text-right text-gray-400">
                  {row.oldUnitBuy > 0 && `(was ${row.oldUnitBuy})`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bulk result banner
// ---------------------------------------------------------------------------

function BulkResultBanner({
  results,
  onDismiss,
}: {
  results: BulkItemResult[]
  onDismiss: () => void
}) {
  const totalFilled = results.reduce((n, r) => n + r.filled.length, 0)
  const anyFilled = totalFilled > 0
  const anyRemainder = results.some((r) => r.remainder > 0)
  const noneFound = results.every((r) => r.filled.length === 0)

  return (
    <div className={`rounded-xl border overflow-hidden ${noneFound ? "border-gray-200 bg-gray-50" : "border-green-200 bg-green-50"}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-inherit">
        <span className={`text-xs font-medium ${noneFound ? "text-gray-500" : "text-green-700"}`}>
          {noneFound
            ? "No pending orders found for any excess item."
            : `${totalFilled} order${totalFilled === 1 ? "" : "s"} filled across ${results.filter((r) => r.filled.length > 0).length} item${results.filter((r) => r.filled.length > 0).length === 1 ? "" : "s"}`}
        </span>
        <div className="flex items-center gap-3">
          {anyRemainder && (
            <span className="text-xs text-yellow-700 bg-yellow-100 border border-yellow-200 rounded-md px-2 py-0.5">
              Some excess remaining
            </span>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Dismiss"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Per-item results */}
      {anyFilled && (
        <div className="divide-y divide-inherit">
          {results.filter((r) => r.filled.length > 0).map((item) => (
            <div key={`${item.event}-${item.items}`}>
              <div className="px-4 py-2 flex items-center justify-between bg-white/40">
                <span className="text-xs font-medium text-foreground">{item.items}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">{item.event}</span>
                  {item.remainder > 0 && (
                    <span className="text-xs text-yellow-700 bg-yellow-100 border border-yellow-200 rounded px-1.5 py-0.5">
                      {item.remainder} remaining
                    </span>
                  )}
                </div>
              </div>
              <table className="w-full text-xs">
                <tbody>
                  {item.filled.map((row, i) => (
                    <tr key={row.rowNumber} className="border-t border-inherit">
                      <td className="px-4 py-2 text-gray-400 w-8">{i + 1}</td>
                      <td className="px-4 py-2 text-foreground">{row.customer}</td>
                      <td className="px-4 py-2 text-foreground text-right font-semibold tabular-nums">{row.unitBuy}</td>
                      <td className="px-4 py-2 text-right text-gray-400 w-20">
                        {row.oldUnitBuy > 0 && `(was ${row.oldUnitBuy})`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
