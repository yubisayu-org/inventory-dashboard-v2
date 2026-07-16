"use client"

import { useState, useMemo, useCallback, useRef } from "react"
import type { ExcessRow, ExcessReason } from "@/lib/db"
import DataGrid, {
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type PaginationState,
} from "@/components/DataGrid"
import { usePaginatedFetch, type PageData } from "@/hooks/usePaginatedFetch"
import { fmt, displayIg } from "@/lib/format"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import EventSelect from "@/components/EventSelect"
import SearchableSelect from "@/components/SearchableSelect"

const PAGE_SIZE = 25

const REASON_LABEL: Record<ExcessReason, string> = {
  overbuy: "Overbuy",
  overship: "Overship",
  wrong_product: "Wrong product",
  broken: "Broken",
  customer_cancelled: "Customer cancelled",
  manual: "Manual entry",
}

const REASON_CLASS: Record<ExcessReason, string> = {
  overbuy: "bg-gray-100 text-gray-700 border-gray-200",
  overship: "bg-blue-50 text-blue-700 border-blue-200",
  wrong_product: "bg-yellow-50 text-yellow-700 border-yellow-200",
  broken: "bg-red-50 text-red-700 border-red-200",
  customer_cancelled: "bg-purple-50 text-purple-700 border-purple-200",
  manual: "bg-teal-50 text-teal-700 border-teal-200",
}

function ReasonBadge({ reason }: { reason: ExcessReason }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-medium border ${REASON_CLASS[reason]}`}>
      {REASON_LABEL[reason]}
    </span>
  )
}

type UpdatedRow = { rowNumber: number; event: string; customer: string; oldUnitBuy: number; unitBuy: number }
type ApplyResult = { filled: UpdatedRow[]; remainder: number }
type BulkItemResult = { event: string; items: string; originalUnitBuy: number; filled: UpdatedRow[]; remainder: number }
type BulkResult = { results: BulkItemResult[] }

export default function ExcessTable() {
  const options = useSheetOptions()
  const [rows, setRows] = useState<ExcessRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [filteredSum, setFilteredSum] = useState<number | null>(null)
  const [busyRow, setBusyRow] = useState<number | null>(null)
  const [pendingRow, setPendingRow] = useState<number | null>(null)
  const [pendingReceipt, setPendingReceipt] = useState("apply excess")
  const [applyResult, setApplyResult] = useState<{ excessRowNumber: number; result: ApplyResult } | null>(null)
  const [bulkPending, setBulkPending] = useState(false)
  const [bulkReceipt, setBulkReceipt] = useState("apply excess")
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [editRow, setEditRow] = useState<ExcessRow | null>(null)
  const [deleteRow, setDeleteRow] = useState<ExcessRow | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Server-side table state.
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState("")
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE })

  const fetchFilters = useMemo<Record<string, string>>(() => {
    const f: Record<string, string> = {}
    for (const cf of columnFilters) {
      const v = String(cf.value ?? "").trim()
      if (!v) continue
      if (cf.id === "event") f.event = v
      else if (cf.id === "items") f.items = v
      else if (cf.id === "receipt") f.receipt = v
      else if (cf.id === "reason") f.reason = v
    }
    return f
  }, [columnFilters])

  const fetchSort = useMemo(() => {
    if (sorting.length === 0) return null
    return { key: sorting[0].id, direction: sorting[0].desc ? ("desc" as const) : ("asc" as const) }
  }, [sorting])

  const onData = useCallback((d: PageData) => {
    setRows(d.rows as ExcessRow[])
    setTotalCount(d.totalCount)
    setFilteredSum(d.filteredSum)
  }, [])

  const { fetchState, refresh } = usePaginatedFetch({
    endpoint: "/api/sheets/excess-purchase",
    pageSize: PAGE_SIZE,
    page: pagination.pageIndex + 1,
    search: globalFilter,
    filters: fetchFilters,
    sort: fetchSort,
    onData,
  })

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  const handleSortingChange = useCallback((u: SortingState | ((p: SortingState) => SortingState)) => {
    setSorting(u); setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleColumnFiltersChange = useCallback((u: ColumnFiltersState | ((p: ColumnFiltersState) => ColumnFiltersState)) => {
    setColumnFilters(u); setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleGlobalFilterChange = useCallback((u: string | ((p: string) => string)) => {
    setGlobalFilter(u); setPagination((p) => ({ ...p, pageIndex: 0 }))
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
      // Server applied against the full set — reload the current page.
      refreshRef.current()
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
      // Row was fully consumed (deleted) or partially reduced — reload the page.
      refreshRef.current()
    } catch (err) {
      setApplyResult({
        excessRowNumber: row.rowNumber,
        result: { filled: [], remainder: row.unitBuy },
      })
    } finally {
      setBusyRow(null)
    }
  }

  async function handleDelete() {
    if (!deleteRow) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/sheets/excess-purchase/${deleteRow.rowNumber}`, { method: "DELETE" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to delete")
      refreshRef.current()
      setDeleteRow(null)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete")
    } finally {
      setDeleteBusy(false)
    }
  }

  const columns = useMemo<ColumnDef<ExcessRow, unknown>[]>(
    () => [
      {
        accessorKey: "event",
        header: "Event",
        filterFn: "textContains",
        size: 140,
      },
      {
        accessorKey: "items",
        header: "Item",
        filterFn: "textContains",
        size: 240,
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="text-foreground truncate">{row.original.items}</div>
            {row.original.expectedItem && (
              <div className="text-[11px] text-yellow-700 truncate">
                expected: {row.original.expectedItem}
              </div>
            )}
          </div>
        ),
      },
      {
        accessorKey: "reason",
        header: "Reason",
        filterFn: "textContains",
        size: 110,
        cell: ({ getValue }) => <ReasonBadge reason={getValue<ExcessReason>()} />,
      },
      {
        accessorKey: "unitBuy",
        header: "Unit Buy",
        enableColumnFilter: false,
        size: 90,
        meta: { align: "right" },
        cell: ({ getValue }) => (
          <span className="font-medium tabular-nums">{fmt(getValue<number>())}</span>
        ),
      },
      {
        accessorKey: "receipt",
        header: "Receipt",
        filterFn: "textContains",
        size: 150,
        cell: ({ getValue }) => (
          <span className="text-gray-500">{getValue<string>() || "—"}</span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: "Created At",
        enableColumnFilter: false,
        size: 120,
        cell: ({ getValue }) => (
          <span className="text-gray-400 text-xs whitespace-nowrap">{getValue<string>()}</span>
        ),
      },
      {
        accessorKey: "updatedAt",
        header: "Updated At",
        enableColumnFilter: false,
        size: 120,
        cell: ({ getValue }) => (
          <span className="text-gray-400 text-xs whitespace-nowrap">{getValue<string>() || "—"}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        enableColumnFilter: false,
        enableHiding: false,
        size: 150,
        cell: ({ row }) => {
          const r = row.original
          const busy = busyRow === r.rowNumber
          const isPending = pendingRow === r.rowNumber
          return (
            <div className="flex items-center justify-end gap-2">
              {/* Broken stock isn't sellable — no apply action. */}
              {r.reason === "broken" ? (
                <span className="text-[11px] text-gray-400 italic">Not sellable</span>
              ) : (
                <button
                  type="button"
                  onClick={() => isPending ? cancelPending() : openPending(r.rowNumber)}
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
              )}
              <button
                type="button"
                onClick={() => setEditRow(r)}
                title="Edit"
                className="text-gray-400 hover:text-brand transition-colors p-1"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => { setDeleteRow(r); setDeleteError(null) }}
                title="Delete"
                className="text-gray-400 hover:text-red-500 transition-colors p-1"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                </svg>
              </button>
            </div>
          )
        },
      },
    ],
    [busyRow, pendingRow],
  )

  const renderMobileCard = useCallback((r: ExcessRow) => {
    const busy = busyRow === r.rowNumber
    const isPending = pendingRow === r.rowNumber
    return (
      <div className="rounded-xl border border-cream-border bg-white p-3.5 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-foreground truncate">{r.items}</div>
            {r.expectedItem && (
              <div className="text-[11px] text-yellow-700 truncate">expected: {r.expectedItem}</div>
            )}
            <div className="text-xs text-gray-400 mt-0.5">{r.event}{r.receipt ? ` · ${r.receipt}` : ""}</div>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <ReasonBadge reason={r.reason} />
            <span className="text-sm font-semibold tabular-nums text-foreground">{fmt(r.unitBuy)}</span>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 pt-1 border-t border-cream-border/60">
          {r.reason === "broken" ? (
            <span className="text-[11px] text-gray-400 italic mr-auto">Not sellable</span>
          ) : (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); isPending ? cancelPending() : openPending(r.rowNumber) }}
              disabled={busy || busyRow !== null}
              className="mr-auto inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-brand text-white hover:bg-brand-hover transition-colors disabled:opacity-50"
            >
              {busy ? "Applying…" : isPending ? "Cancel" : "Apply"}
            </button>
          )}
          <button type="button" onClick={(e) => { e.stopPropagation(); setEditRow(r) }} title="Edit" className="text-gray-400 hover:text-brand transition-colors p-1">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
            </svg>
          </button>
          <button type="button" onClick={(e) => { e.stopPropagation(); setDeleteRow(r); setDeleteError(null) }} title="Delete" className="text-gray-400 hover:text-red-500 transition-colors p-1">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
            </svg>
          </button>
        </div>
      </div>
    )
  }, [busyRow, pendingRow])

  // Find the row object for the pending modal
  const pendingExcessRow = pendingRow != null ? rows.find((r) => r.rowNumber === pendingRow) : null

  if (fetchState.error) {
    return (
      <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-red-500">
        {fetchState.error}
        <button onClick={() => refreshRef.current()} className="ml-2 underline hover:no-underline">Retry</button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Bulk pending form */}
      {bulkPending && (
        <div className="rounded-xl border border-brand/30 bg-brand/5 px-4 py-3 flex items-center gap-3 flex-wrap">
          <span className="text-xs text-gray-600 shrink-0">
            Apply all <strong>{totalCount}</strong> excess rows to pending orders
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

      {/* Apply excess modal */}
      {pendingExcessRow && (
        <ApplyExcessModal
          row={pendingExcessRow}
          receipt={pendingReceipt}
          onReceiptChange={setPendingReceipt}
          onConfirm={() => handleApply(pendingExcessRow)}
          onCancel={cancelPending}
        />
      )}

      {/* Add / Edit inventory modal */}
      {(addOpen || editRow) && (
        <InventoryFormModal
          mode={addOpen ? "add" : "edit"}
          existing={editRow ?? undefined}
          eventOptions={options?.events ?? []}
          itemOptions={(options?.items ?? []).map((it) => ({ value: it.name, label: it.name, meta: it.store || undefined }))}
          onClose={() => { setAddOpen(false); setEditRow(null) }}
          onCreated={() => { refreshRef.current(); setAddOpen(false) }}
          onUpdated={() => { refreshRef.current(); setEditRow(null) }}
        />
      )}

      {/* Delete confirmation */}
      {deleteRow && (
        <DeleteConfirmModal
          row={deleteRow}
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => { setDeleteRow(null); setDeleteError(null) }}
          onConfirm={handleDelete}
        />
      )}

      <DataGrid
        data={rows}
        columns={columns}
        getRowId={(row) => String(row.rowNumber)}
        searchPlaceholder="Search event, item, receipt…"
        renderMobileCard={renderMobileCard}
        serverSide={{
          rowCount: totalCount,
          loading: fetchState.loading,
          sorting,
          onSortingChange: handleSortingChange,
          columnFilters,
          onColumnFiltersChange: handleColumnFiltersChange,
          globalFilter,
          onGlobalFilterChange: handleGlobalFilterChange,
          pagination,
          onPaginationChange: setPagination,
        }}
        toolbarExtra={
          <div className="flex items-center gap-2 shrink-0">
            {filteredSum !== null && (
              <span className="text-xs text-gray-500 whitespace-nowrap">
                Total: <span className="font-semibold text-foreground">{fmt(filteredSum)}</span> units
              </span>
            )}
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-cream-border rounded-lg text-gray-600 hover:border-brand hover:text-brand transition-colors shrink-0"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add Inventory
            </button>
            {totalCount > 0 && (
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
        }
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Apply excess modal
// ---------------------------------------------------------------------------

function ApplyExcessModal({
  row,
  receipt,
  onReceiptChange,
  onConfirm,
  onCancel,
}: {
  row: ExcessRow
  receipt: string
  onReceiptChange: (v: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-xl border border-brand/30 bg-brand/5 px-4 py-3 flex items-center gap-3 flex-wrap">
      <span className="text-xs text-gray-600 shrink-0">
        Apply excess: <strong>{row.items}</strong> ({row.unitBuy} units)
      </span>
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <label className="text-xs text-gray-500 shrink-0">Receipt</label>
        <input
          type="text"
          value={receipt}
          onChange={(e) => onReceiptChange(e.target.value)}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirm()
            if (e.key === "Escape") onCancel()
          }}
          className="flex-1 max-w-xs border border-cream-border rounded-md px-2.5 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
        />
      </div>
      <button
        type="button"
        onClick={onConfirm}
        className="px-3 py-1 text-xs font-medium rounded-md bg-brand text-white hover:bg-brand-hover transition-colors shrink-0"
      >
        Confirm
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="px-3 py-1 text-xs font-medium rounded-md border border-cream-border text-gray-500 hover:bg-cream transition-colors shrink-0"
      >
        Cancel
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add / Edit inventory modal
// ---------------------------------------------------------------------------
//
// Shared by "Add Inventory" (e.g. logging pre-dashboard stock) and "Edit" on
// an existing row. Item is picked from the product catalog rather than typed
// free-text — "Apply" matches purely on exact item-name equality against
// order lines, so a typo here would silently make a row unmatchable forever.

function InventoryFormModal({
  mode,
  existing,
  eventOptions,
  itemOptions,
  onClose,
  onCreated,
  onUpdated,
}: {
  mode: "add" | "edit"
  existing?: ExcessRow
  eventOptions: string[]
  itemOptions: { value: string; label: string; meta?: string }[]
  onClose: () => void
  onCreated: (rows: ExcessRow[]) => void
  onUpdated: (rowNumber: number, patch: { event: string; items: string; unitBuy: number; receipt: string }) => void
}) {
  const [event, setEvent] = useState(existing?.event ?? "")
  const [items, setItems] = useState(existing?.items ?? "")
  const [unitBuy, setUnitBuy] = useState(String(existing?.unitBuy ?? ""))
  const [receipt, setReceipt] = useState(existing?.receipt ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const qtyNum = Math.round(Number(unitBuy)) || 0
  const valid = event.trim() !== "" && items.trim() !== "" && qtyNum >= 1

  async function handleSubmit() {
    if (!valid) return
    setSaving(true)
    setError(null)
    try {
      if (mode === "add") {
        const res = await fetch("/api/sheets/excess-purchase", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event, items, unitBuy: qtyNum, receipt: receipt.trim() }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to add inventory")
        onCreated(data.rows ?? [])
      } else if (existing) {
        const res = await fetch(`/api/sheets/excess-purchase/${existing.rowNumber}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event, items, unitBuy: qtyNum, receipt: receipt.trim() }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to update")
        onUpdated(existing.rowNumber, { event, items, unitBuy: qtyNum, receipt: receipt.trim() })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-sm flex flex-col gap-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="text-sm font-semibold text-foreground">
            {mode === "add" ? "Add Inventory" : "Edit Inventory"}
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-brand transition-colors shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Event</span>
            <EventSelect value={event} onChange={setEvent} events={eventOptions} placeholder="Select event…" disabled={saving} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Item</span>
            <SearchableSelect value={items} onChange={setItems} options={itemOptions} placeholder="Search item…" disabled={saving} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Quantity</span>
            <input
              type="number"
              min={1}
              value={unitBuy}
              onChange={(e) => setUnitBuy(e.target.value)}
              disabled={saving}
              className="w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Note <span className="text-gray-400 font-normal">(optional)</span></span>
            <input
              type="text"
              value={receipt}
              onChange={(e) => setReceipt(e.target.value)}
              disabled={saving}
              placeholder="e.g. pre-dashboard stock"
              className="w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
            />
          </label>
        </div>

        <p className="text-[11px] text-gray-400">
          Apply fills this row&apos;s own event first, then spills to matching orders
          in other events — so Event just sets fill priority.
        </p>

        {error && <p className="text-xs text-red-500">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
            Cancel
          </button>
          <button type="button" onClick={handleSubmit} disabled={saving || !valid} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors">
            {saving ? "Saving…" : mode === "add" ? "Add Inventory" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Delete confirmation
// ---------------------------------------------------------------------------

function DeleteConfirmModal({
  row,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  row: ExcessRow
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onCancel}>
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-sm flex flex-col gap-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-foreground">Delete Inventory Row</div>
        <p className="text-sm text-gray-600">
          Remove <span className="font-medium">{row.items}</span> ({row.unitBuy} unit{row.unitBuy === 1 ? "" : "s"}) from {row.event}? This cannot be undone.
        </p>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
            Keep
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className="px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 disabled:opacity-50 transition-colors">
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
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
            ? "No pending orders found for this item."
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
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[420px]">
            <thead>
              <tr className="border-b border-inherit text-left">
                <th className="px-4 py-2 font-medium text-gray-500 w-8">#</th>
                <th className="px-4 py-2 font-medium text-gray-500">Event</th>
                <th className="px-4 py-2 font-medium text-gray-500">Customer</th>
                <th className="px-4 py-2 font-medium text-gray-500 text-right">Unit Buy</th>
                <th className="px-4 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {filled.map((row, i) => (
                <tr key={row.rowNumber} className="border-b border-inherit last:border-0">
                  <td className="px-4 py-2 text-gray-400">{i + 1}</td>
                  <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{row.event}</td>
                  <td className="px-4 py-2 text-foreground">{displayIg(row.customer)}</td>
                  <td className="px-4 py-2 text-foreground text-right font-semibold tabular-nums">{row.unitBuy}</td>
                  <td className="px-4 py-2 text-right text-gray-400">
                    {row.oldUnitBuy > 0 && `(was ${row.oldUnitBuy})`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[420px]">
                  <tbody>
                    {item.filled.map((row, i) => (
                      <tr key={row.rowNumber} className="border-t border-inherit">
                        <td className="px-4 py-2 text-gray-400 w-8">{i + 1}</td>
                        <td className="px-4 py-2 text-foreground">
                          {displayIg(row.customer)}
                          {row.event !== item.event && (
                            <span className="ml-1.5 text-[10px] text-brand">→ {row.event}</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-foreground text-right font-semibold tabular-nums">{row.unitBuy}</td>
                        <td className="px-4 py-2 text-right text-gray-400 w-20">
                          {row.oldUnitBuy > 0 && `(was ${row.oldUnitBuy})`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
