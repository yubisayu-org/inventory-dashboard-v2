"use client"

import TableSkeleton from "@/components/TableSkeleton"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { FormRow, InvoiceResult, SheetOptions } from "@/lib/db"
import { usePaginatedFetch, type PageData } from "@/hooks/usePaginatedFetch"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { copyToClipboard } from "@/lib/clipboard"
import { fmt, displayIg } from "@/lib/format"
import { useCopyFeedback } from "@/hooks/useCopyFeedback"
import DataGrid, {
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type PaginationState,
  type RowSelectionState,
} from "@/components/DataGrid"
import SearchableSelect from "@/components/SearchableSelect"
import EventSelect from "@/components/EventSelect"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25

const INPUT_CLS =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

// Mirrors the icon used on /dashboard/customers next to customers whose
// data_diri is empty, so a row with no address gets the same amber warning.
function NoAddressIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-amber-500 shrink-0"
      aria-label="No address filled"
    >
      <title>No address filled</title>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

type EditForm = { event: string; customer: string; productId: string; unit: string; note: string }

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function DataTable({ isOwner }: { isOwner: boolean }) {
  const options = useSheetOptions()

  // -- Server-side state (TanStack format) --
  // Default: newest first (sort by created_at desc). created_at is always set,
  // unlike updated_at which is null until a row is edited.
  const [sorting, setSorting] = useState<SortingState>([{ id: "createdAt", desc: true }])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState("")
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE })

  // -- Data from server --
  const [rows, setRows] = useState<FormRow[]>([])
  const [totalCount, setTotalCount] = useState(0)

  // -- UI state --
  const [editingRow, setEditingRow] = useState<FormRow | null>(null)
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [mobileAddOpen, setMobileAddOpen] = useState(false)

  // -- Convert TanStack state → usePaginatedFetch params --
  const fetchFilters = useMemo(() => {
    const f = { event: "", customer: "", items: "" }
    for (const cf of columnFilters) {
      if (cf.id in f) f[cf.id as keyof typeof f] = String(cf.value ?? "")
    }
    return f
  }, [columnFilters])

  const fetchSort = useMemo(() => {
    if (sorting.length === 0) return null
    return { key: sorting[0].id, direction: sorting[0].desc ? "desc" as const : "asc" as const }
  }, [sorting])

  const onData = useCallback((data: PageData) => {
    setRows(data.rows as FormRow[])
    setTotalCount(data.totalCount)
  }, [])

  const { fetchState, refresh } = usePaginatedFetch({
    endpoint: "/api/sheets/duplicate-form",
    pageSize: PAGE_SIZE,
    page: pagination.pageIndex + 1,
    search: globalFilter,
    filters: fetchFilters,
    sort: fetchSort,
    onData,
  })

  // Stable ref for refresh so handlers captured by column defs stay current
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // -- Reset page on filter/sort change --
  const handleSortingChange = useCallback((updater: SortingState | ((prev: SortingState) => SortingState)) => {
    setSorting(updater)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])

  const handleColumnFiltersChange = useCallback((updater: ColumnFiltersState | ((prev: ColumnFiltersState) => ColumnFiltersState)) => {
    setColumnFilters(updater)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])

  const handleGlobalFilterChange = useCallback((updater: string | ((prev: string) => string)) => {
    setGlobalFilter(updater)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])

  // -- Clear selection on page/filter change --
  useEffect(() => {
    setRowSelection({})
  }, [pagination.pageIndex, columnFilters, globalFilter])

  // -- Handlers (stable for column defs) --
  const handleDelete = useCallback(async (rowNumber: number) => {
    if (!confirm("Delete this order? This cannot be undone.")) return
    try {
      const res = await fetch(`/api/sheets/duplicate-form/${rowNumber}`, { method: "DELETE" })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Failed to delete") }
      setEditingRow(null)
      await refreshRef.current()
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete row")
    }
  }, [])

  // Owner-only inline cell edit. Optimistic local update on success so the
  // table doesn't have to round-trip a full refetch for every keystroke commit.
  // On failure, throws so the cell can revert its input to the previous value.
  const handleCellSave = useCallback(async (
    rowNumber: number,
    column: "unit_buy" | "unit_arrive",
    value: number | null,
  ) => {
    const res = await fetch(`/api/sheets/duplicate-form/${rowNumber}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "owner_cell", column, value }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error ?? "Failed to save")
    }
    setRows((rs) => rs.map((r) =>
      r.rowNumber === rowNumber
        ? { ...r, ...(column === "unit_buy" ? { unitBuy: value } : { unitArrive: value }) }
        : r,
    ))
  }, [])

  async function handleBulkDelete() {
    const ids = Object.keys(rowSelection).filter((k) => rowSelection[k]).map(Number)
    if (ids.length === 0) return
    if (!confirm(`Delete ${ids.length} selected order${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return
    setBulkDeleting(true)
    const sorted = ids.sort((a, b) => b - a)
    if (editingRow && ids.includes(editingRow.rowNumber)) setEditingRow(null)
    try {
      for (const rowNumber of sorted) {
        const res = await fetch(`/api/sheets/duplicate-form/${rowNumber}`, { method: "DELETE" })
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `Failed to delete row ${rowNumber}`) }
      }
      setRowSelection({})
      await refreshRef.current()
    } catch (err) {
      alert(err instanceof Error ? err.message : "Bulk delete failed")
      await refreshRef.current()
    } finally {
      setBulkDeleting(false)
    }
  }

  // -- Column definitions --
  const columns: ColumnDef<FormRow, unknown>[] = useMemo(() => [
    {
      accessorKey: "event",
      header: "Event",
      filterFn: "textContains",
    },
    {
      accessorKey: "customer",
      header: "Customer",
      filterFn: "textContains",
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <CopyableText text={displayIg(row.original.customer)} />
          {!row.original.hasAddress && <NoAddressIcon />}
        </span>
      ),
    },
    {
      accessorKey: "items",
      header: "Item",
      filterFn: "textContains",
      enableHiding: false,
    },
    {
      accessorKey: "unit",
      header: "Qty",
      enableColumnFilter: false,
      size: 80,
      meta: { align: "right" },
      cell: ({ getValue }) => <span className="tabular-nums">{fmt(getValue<number>())}</span>,
    },
    {
      accessorKey: "unitBuy",
      header: "Buy",
      enableColumnFilter: false,
      enableSorting: true,
      size: 80,
      meta: { align: "right" },
      cell: ({ row }) => (
        <EditableNumberCell
          value={row.original.unitBuy}
          canEdit={isOwner}
          onSave={(v) => handleCellSave(row.original.rowNumber, "unit_buy", v)}
        />
      ),
    },
    {
      accessorKey: "unitArrive",
      header: "Arrive",
      enableColumnFilter: false,
      enableSorting: true,
      size: 80,
      meta: { align: "right" },
      cell: ({ row }) => (
        <EditableNumberCell
          value={row.original.unitArrive}
          canEdit={isOwner}
          onSave={(v) => handleCellSave(row.original.rowNumber, "unit_arrive", v)}
        />
      ),
    },
    {
      accessorKey: "note",
      header: "Note",
      enableColumnFilter: false,
      cell: ({ getValue }) => <span className="text-gray-500 text-xs">{getValue<string>() || "—"}</span>,
    },
    {
      accessorKey: "createdAt",
      header: "Created At",
      enableColumnFilter: false,
      cell: ({ getValue }) => <span className="text-gray-400 text-xs whitespace-nowrap">{getValue<string>() || "—"}</span>,
    },
    {
      accessorKey: "updatedAt",
      header: "Updated At",
      enableColumnFilter: false,
      cell: ({ getValue }) => <span className="text-gray-400 text-xs whitespace-nowrap">{getValue<string>() || "—"}</span>,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableColumnFilter: false,
      enableHiding: false,
      size: 100,
      meta: { align: "right" },
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <CopyInvoiceRowButton row={row.original} />
          <button
            onClick={() => setEditingRow(row.original)}
            title="Edit"
            className="p-1 text-gray-400 hover:text-brand transition-colors rounded"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          <button
            onClick={() => handleDelete(row.original.rowNumber)}
            title="Delete"
            className="p-1 text-gray-400 hover:text-red-500 transition-colors rounded"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
            </svg>
          </button>
        </div>
      ),
    },
  ], [handleDelete, handleCellSave, isOwner])

  // -- Toolbar extras --
  const selectedCount = Object.keys(rowSelection).filter((k) => rowSelection[k]).length

  const toolbarExtra = (
    <>
      {selectedCount > 0 && (
        <button
          onClick={handleBulkDelete}
          disabled={bulkDeleting}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-500 hover:bg-red-50 hover:border-red-400 transition-colors disabled:opacity-50"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
          </svg>
          {bulkDeleting ? "Deleting…" : `Delete ${selectedCount}`}
        </button>
      )}

      <button onClick={refresh} title="Refresh" className="p-1.5 text-gray-400 hover:text-brand transition-colors rounded">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-6.22-8.56" /><polyline points="21 3 21 9 15 9" />
        </svg>
      </button>
    </>
  )

  // -- Loading / error states --
  if (fetchState.loading && rows.length === 0) return <TableSkeleton />

  if (fetchState.error) {
    return (
      <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-4 text-sm text-red-700">
        <p className="font-medium mb-1">Failed to load data</p>
        <p>{fetchState.error}</p>
        <button onClick={refresh} className="mt-3 text-sm underline hover:no-underline">Retry</button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Add form (desktop) */}
      <div className="hidden md:block">
        <AddOrderForm options={options} onOrderAdded={() => refreshRef.current()} />
      </div>

      {fetchState.refreshError && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 rounded-lg border border-red-200 bg-red-50 text-xs text-red-600">
          <span>Refresh failed: {fetchState.refreshError}</span>
          <button onClick={refresh} className="underline hover:no-underline shrink-0">Retry</button>
        </div>
      )}

      {/* Desktop table */}
      <div className="hidden md:block">
        <DataGrid
          data={rows}
          columns={columns}
          getRowId={(row) => String(row.rowNumber)}
          searchPlaceholder="Search orders..."
          toolbarExtra={toolbarExtra}
          initialVisibility={{ unitBuy: false, unitArrive: false, note: false, createdAt: false, updatedAt: false }}
          enableRowSelection
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
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
        />
      </div>

      {/* Mobile list */}
      <div className="md:hidden flex flex-col gap-2.5">
        <div className="flex gap-2">
          <input
            value={globalFilter}
            onChange={(e) => handleGlobalFilterChange(e.target.value)}
            placeholder="Search orders…"
            className="flex-1 border border-cream-border rounded-xl px-3.5 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
          />
          <button
            type="button"
            onClick={() => handleSortingChange([{ id: "createdAt", desc: !((sorting.find((s) => s.id === "createdAt")?.desc) ?? true) }])}
            aria-label="Toggle sort order"
            className="shrink-0 inline-flex items-center gap-1 px-3 rounded-xl border border-cream-border bg-white text-xs font-medium text-gray-600 active:border-brand active:text-brand"
          >
            {((sorting.find((s) => s.id === "createdAt")?.desc) ?? true) ? "Newest" : "Oldest"}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {((sorting.find((s) => s.id === "createdAt")?.desc) ?? true) ? <path d="m6 9 6 6 6-6" /> : <path d="m18 15-6-6-6 6" />}
            </svg>
          </button>
        </div>
        {rows.length === 0 && (
          <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-gray-400">
            {fetchState.loading ? "Loading…" : "No orders"}
          </div>
        )}
        {rows.map((r) => {
          const bought = (r.unitBuy ?? 0) > 0
          return (
            <div key={r.rowNumber} className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-1.5 min-w-0">
                  <div className="font-semibold text-sm text-foreground truncate"><span className="text-gray-300">@</span>{r.customer.replace(/^@/, "")}</div>
                  {!r.hasAddress && <NoAddressIcon />}
                </div>
                <span className="shrink-0 text-[11px] text-gray-600 bg-cream border border-cream-border rounded-md px-2 py-0.5 font-semibold">{r.event}</span>
              </div>
              <div className="flex items-start justify-between gap-3 mt-2">
                <div className="text-sm text-foreground">{r.items}</div>
                <span className="shrink-0 inline-block px-2 py-0.5 rounded-full text-[11px] font-bold bg-brand/10 text-brand">×{r.unit}</span>
              </div>
              {r.note && <div className="text-xs text-gray-400 italic mt-1">Note: {r.note}</div>}
              <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-cream-border">
                <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium border ${bought ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-50 text-gray-500 border-cream-border"}`}>
                  {bought ? "Bought" : "Not bought"}
                </span>
                <div className="flex gap-0.5">
                  <CopyInvoiceRowButton row={r} />
                  <button type="button" onClick={() => setEditingRow(r)} aria-label="Edit" className="p-2 rounded-lg text-gray-400 active:bg-cream active:text-brand">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" /></svg>
                  </button>
                  <button type="button" onClick={() => handleDelete(r.rowNumber)} aria-label="Delete" className="p-2 rounded-lg text-gray-400 active:bg-cream active:text-red-500">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                  </button>
                </div>
              </div>
            </div>
          )
        })}
        {totalCount > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-3 pt-1">
            <button type="button" disabled={pagination.pageIndex === 0} onClick={() => setPagination((p) => ({ ...p, pageIndex: p.pageIndex - 1 }))} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm text-gray-600 disabled:opacity-40">Prev</button>
            <span className="text-xs text-gray-400">Page {pagination.pageIndex + 1} of {Math.max(1, Math.ceil(totalCount / PAGE_SIZE))}</span>
            <button type="button" disabled={(pagination.pageIndex + 1) * PAGE_SIZE >= totalCount} onClick={() => setPagination((p) => ({ ...p, pageIndex: p.pageIndex + 1 }))} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm text-gray-600 disabled:opacity-40">Next</button>
          </div>
        )}
      </div>

      {/* Mobile add FAB */}
      <button type="button" onClick={() => setMobileAddOpen(true)} aria-label="Add order" className="md:hidden fixed right-4 bottom-20 z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90">+</button>

      {/* Mobile add sheet */}
      {mobileAddOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40 flex flex-col justify-end" onClick={() => setMobileAddOpen(false)}>
          <div className="bg-cream rounded-t-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 sticky top-0 bg-cream/95 backdrop-blur z-10">
              <span className="font-semibold text-foreground">New Order</span>
              <button type="button" onClick={() => setMobileAddOpen(false)} aria-label="Close" className="text-gray-400 p-1"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg></button>
            </div>
            <div className="px-3 pb-8">
              <AddOrderForm options={options} onOrderAdded={() => { setMobileAddOpen(false); refreshRef.current() }} />
            </div>
          </div>
        </div>
      )}

      {editingRow && (
        <EditOrderModal
          row={editingRow}
          options={options}
          isOwner={isOwner}
          onClose={() => setEditingRow(null)}
          onSaved={() => refreshRef.current()}
          onDelete={handleDelete}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CopyableText — inline copy button for customer names
// ---------------------------------------------------------------------------

function CopyableText({ text }: { text: string }) {
  const { copied, copy } = useCopyFeedback()

  return (
    <span className="inline-flex items-center gap-1 group">
      <span className="text-foreground">{text}</span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); copy(text) }}
        title="Copy"
        className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-gray-400 hover:text-brand"
      >
        {copied ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-600">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    </span>
  )
}

// ---------------------------------------------------------------------------
// EditableNumberCell — owner-only inline number edit for Buy / Arrive columns
// ---------------------------------------------------------------------------

function EditableNumberCell({ value, canEdit, onSave }: {
  value: number | null
  canEdit: boolean
  onSave: (value: number | null) => Promise<void>
}) {
  // Admin (and anyone else without edit rights) just sees the number.
  if (!canEdit) {
    return <span className="tabular-nums">{value == null ? <span className="text-gray-300">—</span> : fmt(value)}</span>
  }

  // Owner gets a click-anywhere-in-cell number input. We hold an internal
  // draft so partial typing doesn't fight with React re-renders, and reset it
  // whenever the canonical value from the row changes (e.g. on refresh).
  const [draft, setDraft] = useState(value == null ? "" : String(value))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastValueRef = useRef(value)

  useEffect(() => {
    // Only resync when the row's value actually changes — typing into the
    // input would otherwise wipe the draft as setRows propagates.
    if (lastValueRef.current !== value) {
      lastValueRef.current = value
      setDraft(value == null ? "" : String(value))
    }
  }, [value])

  async function commit() {
    const trimmed = draft.trim()
    const newValue = trimmed === "" ? null : Number(trimmed)
    if (newValue !== null && !Number.isFinite(newValue)) {
      setError("Invalid")
      setDraft(value == null ? "" : String(value))
      return
    }
    if (newValue === value) {
      setError(null)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(newValue)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setDraft(value == null ? "" : String(value))
    } finally {
      setSaving(false)
    }
  }

  return (
    <input
      type="number"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur()
        if (e.key === "Escape") {
          setDraft(value == null ? "" : String(value))
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      disabled={saving}
      placeholder="—"
      title={error ?? undefined}
      className={`w-full bg-transparent border px-2 py-0.5 text-right tabular-nums rounded transition-colors ${
        error
          ? "border-red-300 text-red-700"
          : "border-transparent hover:border-cream-border focus:border-brand focus:bg-white focus:outline-none"
      } disabled:opacity-50`}
    />
  )
}

// ---------------------------------------------------------------------------
// CopyInvoiceRowButton — copy the invoice message for a row's customer
// ---------------------------------------------------------------------------

type InvoiceCopyState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "copied" }
  | { status: "error"; message: string }

function CopyInvoiceRowButton({ row }: { row: FormRow }) {
  const [state, setState] = useState<InvoiceCopyState>({ status: "idle" })

  useEffect(() => {
    if (state.status === "idle") return
    const delay = state.status === "error" ? 3000 : 1500
    const timer = setTimeout(() => setState({ status: "idle" }), delay)
    return () => clearTimeout(timer)
  }, [state.status])

  async function handleClick() {
    setState({ status: "loading" })
    try {
      const res = await fetch(`/api/sheets/invoice?customer=${encodeURIComponent(row.customer)}`, { cache: "no-store" })
      const data: InvoiceResult = await res.json()
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "Failed")
      // Pick the event this row belongs to — not just the latest. A customer can
      // have several events, so blindly taking the last one copied the wrong invoice.
      const event = data.events.find((e) => e.eventId === row.event)
      if (!event) throw new Error(`No invoice found for ${row.customer} · ${row.event}`)
      await copyToClipboard(event.message)
      setState({ status: "copied" })
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Failed" })
    }
  }

  const { status } = state
  const label =
    status === "loading" ? "…"
    : status === "copied" ? "✓"
    : status === "error" ? "!"
    : undefined

  return (
    <button
      onClick={handleClick}
      disabled={status === "loading"}
      title={status === "error" ? state.message : "Copy invoice message"}
      className={`p-1 transition-colors rounded disabled:opacity-50 ${
        status === "copied" ? "text-green-600"
        : status === "error" ? "text-red-500"
        : "text-gray-400 hover:text-brand"
      }`}
    >
      {label ? (
        <span className="text-xs font-medium w-3.5 inline-block text-center">{label}</span>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
          <path d="M14 2v6h6" />
          <path d="M8 13h8" />
          <path d="M8 17h5" />
        </svg>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Edit Order Modal
// ---------------------------------------------------------------------------

function EditOrderModal({ row, options, isOwner, onClose, onSaved, onDelete }: {
  row: FormRow
  options: SheetOptions | null
  isOwner: boolean
  onClose: () => void
  onSaved: () => void
  onDelete: (rowNumber: number) => void
}) {
  const [form, setForm] = useState<EditForm>({
    event: row.event,
    customer: row.customer,
    productId: String(row.productId),
    unit: String(row.unit),
    note: row.note,
  })
  // Owner-only quantity correction. Empty string clears the column back to NULL
  // so the row reverts to "not bought" / "not arrived" instead of being forced to 0.
  const [unitBuy, setUnitBuy] = useState<string>(row.unitBuy == null ? "" : String(row.unitBuy))
  const [unitArrive, setUnitArrive] = useState<string>(row.unitArrive == null ? "" : String(row.unitArrive))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const customerOptions = useMemo(
    () => (options?.customers ?? []).map((c) => ({ value: c, label: displayIg(c) })),
    [options],
  )
  const itemOptions = useMemo(
    () => (options?.items ?? []).map((it) => ({ value: String(it.id), label: it.name, meta: it.store || undefined })),
    [options],
  )

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError("")
    try {
      const pid = Number(form.productId)
      const product = options?.items.find((it) => it.id === pid)
      const res = await fetch(`/api/sheets/duplicate-form/${row.rowNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: "1",
          event: form.event,
          customer: form.customer,
          productId: pid,
          unitPrice: product?.price ?? 0,
          unit: Number(form.unit),
          note: form.note,
        }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Failed to save") }

      if (isOwner) {
        // Issue a single-column PUT per changed field via stage:"owner_cell".
        // Keeping them as separate calls avoids clobbering sibling fields and
        // matches the contract used by the inline cell editors on the table.
        const buyOriginal = row.unitBuy == null ? "" : String(row.unitBuy)
        const arriveOriginal = row.unitArrive == null ? "" : String(row.unitArrive)
        const pending: Array<{ column: "unit_buy" | "unit_arrive"; value: number | null }> = []
        if (unitBuy !== buyOriginal) {
          pending.push({ column: "unit_buy", value: unitBuy === "" ? null : Number(unitBuy) })
        }
        if (unitArrive !== arriveOriginal) {
          pending.push({ column: "unit_arrive", value: unitArrive === "" ? null : Number(unitArrive) })
        }
        for (const p of pending) {
          const res2 = await fetch(`/api/sheets/duplicate-form/${row.rowNumber}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stage: "owner_cell", column: p.column, value: p.value }),
          })
          if (!res2.ok) { const d = await res2.json(); throw new Error(d.error ?? `Failed to save ${p.column}`) }
        }
      }

      onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-foreground">Edit Order</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-brand transition-colors">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Event</label>
            <EventSelect value={form.event} onChange={(v) => setForm((f) => ({ ...f, event: v }))} events={options?.events ?? []} />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Customer</label>
            <SearchableSelect
              value={form.customer}
              onChange={(v) => setForm((f) => ({ ...f, customer: v }))}
              options={customerOptions}
              placeholder="Search or type new customer..."
              allowNewValue
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Item</label>
            <SearchableSelect
              value={form.productId}
              onChange={(v) => setForm((f) => ({ ...f, productId: v }))}
              options={itemOptions}
              placeholder="Search item..."
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-gray-500 mb-1 block">Qty</label>
              <input type="number" min="0" value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} className={INPUT_CLS} />
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-500 mb-1 block">Note</label>
              <input type="text" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="Optional" className={INPUT_CLS} />
            </div>
          </div>

          {isOwner && (
            <div className="pt-2 border-t border-cream-border">
              <div className="text-xs font-medium text-gray-500 mb-2">Owner only · manual correction</div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="text-xs text-gray-500 mb-1 block">Buy</label>
                  <input type="number" min="0" value={unitBuy} onChange={(e) => setUnitBuy(e.target.value)} placeholder="—" className={INPUT_CLS} />
                </div>
                <div className="flex-1">
                  <label className="text-xs text-gray-500 mb-1 block">Arrive</label>
                  <input type="number" min="0" value={unitArrive} onChange={(e) => setUnitArrive(e.target.value)} placeholder="—" className={INPUT_CLS} />
                </div>
              </div>
              <p className="text-[11px] text-gray-400 mt-1.5">Leave blank to clear. Shipped and held units are managed from the Packing List page.</p>
            </div>
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}

          <div className="flex items-center gap-2 pt-2">
            <button type="submit" disabled={saving} className="flex-1 py-2 text-sm font-medium rounded-lg bg-brand text-white hover:bg-brand-hover transition-colors disabled:opacity-50">
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-foreground transition-colors">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { onClose(); onDelete(row.rowNumber) }}
              className="px-3 py-2 text-sm text-red-400 hover:text-red-600 transition-colors"
            >
              Delete
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add Order Form (above table)
// ---------------------------------------------------------------------------

let _addLineId = 0
function newAddLine() { return { id: _addLineId++, productId: "", unit: "", note: "" } }

function AddOrderForm({ options, onOrderAdded }: {
  options: SheetOptions | null
  onOrderAdded: () => void
}) {
  const [event, setEvent] = useState("")
  const [customer, setCustomer] = useState("")
  const [lines, setLines] = useState([newAddLine()])
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null)

  const customerOptions = useMemo(
    () => (options?.customers ?? []).map((c) => ({ value: c, label: displayIg(c) })),
    [options],
  )
  const itemOptions = useMemo(
    () => (options?.items ?? []).map((it) => ({ value: String(it.id), label: it.name, meta: it.store || undefined })),
    [options],
  )

  function updateLine(id: number, field: "productId" | "unit" | "note", value: string) {
    setLines((prev) => prev.map((l) => l.id === id ? { ...l, [field]: value } : l))
    setFeedback(null)
  }
  function addLine() { setLines((prev) => [...prev, newAddLine()]) }
  function removeLine(id: number) { setLines((prev) => prev.filter((l) => l.id !== id)) }

  const canSubmit = Boolean(event) && Boolean(customer) &&
    lines.length > 0 && lines.every((l) => l.productId && l.unit && Number(l.unit) > 0)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true); setFeedback(null)
    try {
      const res = await fetch("/api/sheets/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: lines.map((l) => {
            const pid = Number(l.productId)
            const product = options?.items.find((it) => it.id === pid)
            return { event, customer, productId: pid, unitPrice: product?.price ?? 0, unit: Number(l.unit), note: l.note }
          }),
        }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Failed to save") }
      const count = lines.length
      setFeedback({ type: "success", message: `${count} order${count === 1 ? "" : "s"} added` })
      setEvent(""); setCustomer(""); setLines([newAddLine()])
      onOrderAdded()
    } catch (err) {
      setFeedback({ type: "error", message: err instanceof Error ? err.message : "Failed to save" })
    } finally {
      setSubmitting(false)
    }
  }

  const LABEL = "text-xs text-gray-500 mb-1 block"

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-cream-border bg-white p-5 flex flex-col gap-4">
      <div className="text-sm font-semibold text-foreground">Add Order</div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL}>Event <span className="text-brand">*</span></label>
          <EventSelect value={event} onChange={(v) => { setEvent(v); setFeedback(null) }} events={options?.events ?? []} placeholder="Select event…" />
        </div>
        <div>
          <label className={LABEL}>Customer <span className="text-brand">*</span></label>
          <SearchableSelect
            value={customer}
            onChange={(v) => { setCustomer(v); setFeedback(null) }}
            options={customerOptions}
            placeholder="Search or type new customer..."
            allowNewValue
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className={LABEL + " mb-0"}>Items <span className="text-brand">*</span></span>
          <button type="button" onClick={addLine} className="text-xs text-brand hover:underline">+ Add item</button>
        </div>
        <div className="space-y-3">
          {lines.map((line, idx) => (
            <div key={line.id} className="rounded-lg border border-cream-border p-3 relative">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_auto]">
                <div>
                  <label className={LABEL}>Item {lines.length > 1 ? idx + 1 : ""}</label>
                  <SearchableSelect
                    value={line.productId}
                    onChange={(v) => updateLine(line.id, "productId", v)}
                    options={itemOptions}
                    placeholder="Search item..."
                  />
                </div>
                <div className="w-24">
                  <label className={LABEL}>Qty</label>
                  <input type="number" min="1" value={line.unit} onChange={(e) => updateLine(line.id, "unit", e.target.value)} placeholder="Qty" className={INPUT_CLS} />
                </div>
                <div className="w-32">
                  <label className={LABEL}>Note</label>
                  <input type="text" value={line.note} onChange={(e) => updateLine(line.id, "note", e.target.value)} placeholder="Optional" className={INPUT_CLS} />
                </div>
              </div>
              {lines.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeLine(line.id)}
                  className="absolute top-2 right-2 text-gray-300 hover:text-red-400 transition-colors"
                  aria-label="Remove"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        {feedback && <p className={`text-xs ${feedback.type === "success" ? "text-green-600" : "text-red-600"}`}>{feedback.message}</p>}
        <button
          type="submit"
          disabled={submitting || !canSubmit}
          className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? "Saving..." : `Submit ${lines.length > 1 ? `${lines.length} Orders` : "Order"}`}
        </button>
      </div>
    </form>
  )
}
