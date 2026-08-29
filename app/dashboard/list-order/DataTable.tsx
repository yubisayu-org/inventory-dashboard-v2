"use client"

import TableSkeleton from "@/components/TableSkeleton"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { FormRow, SheetOptions, ProductRow } from "@/lib/db"
import { usePaginatedFetch, type PageData } from "@/hooks/usePaginatedFetch"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import CopyInvoiceButton from "@/components/CopyInvoiceButton"
import { fmt, displayIg } from "@/lib/format"
import { rowsFromForm, type OrderFormMode } from "@/lib/order-rows"
import { useCopyFeedback } from "@/hooks/useCopyFeedback"
import DataGrid, {
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type PaginationState,
  type RowSelectionState,
} from "@/components/DataGrid"
import { useHitAndRun, handleKey, marksFor } from "@/hooks/useHitAndRun"
import { useShrinkCause, type ShrinkCause } from "./StrandedUnitsDialog"
import { HitAndRunFlag } from "@/components/HitAndRunFlag"
import SearchableSelect from "@/components/SearchableSelect"
import SearchInput from "@/components/SearchInput"
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

// Matches order-requests' "Duplicate as variant" icon exactly — same feature,
// same glyph, so it reads as the same action wherever it shows up.
function TagIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" />
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
  // Mobile note filter: "" = all, "has" = only rows with a note, "none" = blank.
  const [noteFilter, setNoteFilter] = useState<"" | "has" | "none">("")
  const [noteFilterOpen, setNoteFilterOpen] = useState(false)
  const noteFilterRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!noteFilterOpen) return
    const h = (e: MouseEvent) => { if (!noteFilterRef.current?.contains(e.target as Node)) setNoteFilterOpen(false) }
    document.addEventListener("mousedown", h)
    return () => document.removeEventListener("mousedown", h)
  }, [noteFilterOpen])
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE })

  // -- Data from server --
  const [rows, setRows] = useState<FormRow[]>([])
  const [totalCount, setTotalCount] = useState(0)

  // -- UI state --
  const [editingRow, setEditingRow] = useState<FormRow | null>(null)
  const [duplicatingRow, setDuplicatingRow] = useState<FormRow | null>(null)
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [mobileAddOpen, setMobileAddOpen] = useState(false)

  // -- Convert TanStack state → usePaginatedFetch params --
  const fetchFilters = useMemo(() => {
    const f = { event: "", customer: "", items: "", dateFrom: "", dateTo: "", note: "" }
    for (const cf of columnFilters) {
      // Date column carries a {from,to} range object, not a plain string.
      if (cf.id === "createdAt") {
        const { from, to } = (cf.value as { from?: string; to?: string } | undefined) ?? {}
        f.dateFrom = from ?? ""
        f.dateTo = to ?? ""
        continue
      }
      if (cf.id in f) f[cf.id as keyof typeof f] = String(cf.value ?? "")
    }
    if (noteFilter) f.note = noteFilter
    return f
  }, [columnFilters, noteFilter])

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
      // A refusal carries its own reason -- bought or shipped units -- and that
      // sentence says what to do instead. Do not flatten it.
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Failed to delete") }
      setEditingRow(null)
      await refreshRef.current()
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete row")
    }
  }, [])

  // One dialog for the whole table: any cell that strands a bought unit asks
  // the same question, in the same words.
  const { ask: askCause, dialog: causeDialog } = useShrinkCause()

  // Owner-only inline cell edit. Optimistic local update on success so the
  // table doesn't have to round-trip a full refetch for every keystroke commit.
  // On failure, throws so the cell can revert its input to the previous value.
  const handleCellSave = useCallback(async (
    rowNumber: number,
    column: "unit_buy" | "unit_arrive" | "unit_dispatch",
    value: number | null,
  ) => {
    // Through the shared helper, so an inline cell asks the same question the
    // modal does: typing 4 into Buy on an order of 3 strands a unit exactly as
    // dropping the order to 2 would.
    const { banked } = await putOrderEdit(rowNumber, { stage: "owner_cell", column, value }, askCause)
    setRows((rs) => rs.map((r) => {
      if (r.rowNumber !== rowNumber) return r
      // Banking moves the surplus onto the shelf and off the order, so the
      // saved figure is the order's own unit — not the number just typed.
      const settled = banked > 0 && column === "unit_buy" ? r.unit : value
      return { ...r, ...(column === "unit_buy" ? { unitBuy: settled }
        : column === "unit_dispatch" ? { unitDispatch: value }
        : { unitArrive: value }) }
    }))
  }, [askCause])

  const handleNoteSave = useCallback(async (rowNumber: number, value: string) => {
    const res = await fetch(`/api/sheets/duplicate-form/${rowNumber}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "note_cell", value }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error ?? "Failed to save")
    }
    setRows((rs) => rs.map((r) => (r.rowNumber === rowNumber ? { ...r, note: value } : r)))
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
      size: 130,
      filterFn: "textContains",
    },
    {
      accessorKey: "customer",
      header: "Customer",
      size: 160,
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
      size: 180,
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
      accessorKey: "unitPrice",
      header: "Unit Price",
      enableColumnFilter: false,
      enableSorting: true,
      size: 110,
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
      accessorKey: "unitDispatch",
      header: "Dispatch",
      enableColumnFilter: false,
      enableSorting: true,
      size: 90,
      meta: { align: "right" },
      cell: ({ row }) => (
        <EditableNumberCell
          value={row.original.unitDispatch}
          canEdit={isOwner}
          onSave={(v) => handleCellSave(row.original.rowNumber, "unit_dispatch", v)}
        />
      ),
    },
    {
      accessorKey: "dispatchReceipt",
      header: "Dispatch Ref",
      enableColumnFilter: false,
      size: 140,
      cell: ({ getValue }) => {
        const v = getValue<string>()
        return <span className="whitespace-nowrap">{v || "—"}</span>
      },
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
      // Read-only: unit_ship is set by the Ship flow, not editable here.
      accessorKey: "unitShip",
      header: "Ship",
      enableColumnFilter: false,
      enableSorting: true,
      size: 80,
      meta: { align: "right" },
      cell: ({ getValue }) => {
        const v = getValue<number | null>()
        return <span className="tabular-nums">{v == null ? <span className="text-faint">—</span> : fmt(v)}</span>
      },
    },
    {
      accessorKey: "note",
      header: "Note",
      enableColumnFilter: false,
      size: 200,
      cell: ({ row }) => (
        <EditableTextCell
          value={row.original.note}
          onSave={(v) => handleNoteSave(row.original.rowNumber, v)}
        />
      ),
    },
    {
      accessorKey: "createdAt",
      header: "Created At",
      size: 110,
      filterFn: "dateRange",
      cell: ({ getValue }) => <span className="text-faint text-xs whitespace-nowrap">{getValue<string>() || "—"}</span>,
    },
    {
      accessorKey: "updatedAt",
      header: "Updated At",
      size: 110,
      enableColumnFilter: false,
      cell: ({ getValue }) => <span className="text-faint text-xs whitespace-nowrap">{getValue<string>() || "—"}</span>,
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
          <CopyInvoiceButton customer={row.original.customer} event={row.original.event} />
          <button
            onClick={() => setDuplicatingRow(row.original)}
            title="Duplicate as variant"
            className="inline-flex items-center justify-center p-1 text-faint hover:text-brand transition-colors rounded"
          >
            <TagIcon />
          </button>
          <button
            onClick={() => setEditingRow(row.original)}
            title="Edit"
            className="inline-flex items-center justify-center p-1 text-faint hover:text-brand transition-colors rounded"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          <button
            onClick={() => handleDelete(row.original.rowNumber)}
            title="Delete"
            className="inline-flex items-center justify-center p-1 text-faint hover:text-red-500 transition-colors rounded"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
            </svg>
          </button>
        </div>
      ),
    },
  ], [handleDelete, handleCellSave, handleNoteSave, isOwner])

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
      <button
        type="button"
        onClick={() => setAddOpen((o) => !o)}
        className={`hidden md:inline-flex items-center gap-1.5 h-[38px] px-4 text-sm rounded-lg border transition-colors ${
          addOpen ? "bg-brand-light text-brand border-brand/30" : "bg-brand text-white border-transparent hover:bg-brand-dark"
        }`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        Add Order
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
          fullWidthSearch
          tightToolbar
          boldUppercaseHeader
          toolbarExtraAfterColumns
          hideRowCount
          belowToolbar={
            addOpen ? (
              <AddOrderForm options={options} onOrderAdded={() => refreshRef.current()} onCancel={() => setAddOpen(false)} />
            ) : undefined
          }
          toolbarExtra={toolbarExtra}
          initialVisibility={{ unitBuy: false, unitArrive: false, unitShip: false, unitDispatch: false, dispatchReceipt: false, note: false, updatedAt: false }}
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
          <SearchInput
            value={globalFilter}
            onChange={handleGlobalFilterChange}
            placeholder="Search orders…"
            className="flex-1 min-w-0"
          />
          <button
            type="button"
            onClick={() => handleSortingChange([{ id: "createdAt", desc: !((sorting.find((s) => s.id === "createdAt")?.desc) ?? true) }])}
            aria-label="Toggle sort order"
            className="shrink-0 inline-flex items-center gap-1 px-3 rounded-lg border border-cream-border bg-white text-sm font-medium text-muted-strong active:border-brand active:text-brand"
          >
            {((sorting.find((s) => s.id === "createdAt")?.desc) ?? true) ? "Newest" : "Oldest"}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {((sorting.find((s) => s.id === "createdAt")?.desc) ?? true) ? <path d="m6 9 6 6 6-6" /> : <path d="m18 15-6-6-6 6" />}
            </svg>
          </button>
          <div className="relative shrink-0" ref={noteFilterRef}>
            <button
              type="button"
              onClick={() => setNoteFilterOpen((o) => !o)}
              aria-label="Filter by note"
              className={`inline-flex items-center h-[38px] px-3 rounded-lg border bg-white text-sm font-medium active:border-brand active:text-brand ${noteFilter ? "border-brand text-brand" : "border-cream-border text-muted-strong"}`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
            </button>
            {noteFilterOpen && (
              <div className="absolute right-0 top-full mt-1 z-30 w-36 rounded-lg border border-cream-border bg-white shadow-lg p-1.5 flex flex-col">
                {[
                  { key: "" as const, label: "All" },
                  { key: "has" as const, label: "Has note" },
                  { key: "none" as const, label: "No note" },
                ].map(({ key, label }) => (
                  <button
                    key={key || "all"}
                    type="button"
                    onClick={() => {
                      setNoteFilter(key)
                      setPagination((p) => ({ ...p, pageIndex: 0 }))
                      setNoteFilterOpen(false)
                    }}
                    className={`text-left px-4 py-2 rounded-lg text-sm transition-colors ${noteFilter === key ? "bg-brand-light text-brand font-medium" : "text-muted-strong hover:bg-cream"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {rows.length === 0 && (
          <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-faint">
            {fetchState.loading ? "Loading…" : "No orders"}
          </div>
        )}
        {rows.map((r) => {
          const bought = (r.unitBuy ?? 0) > 0
          return (
            <div
              key={r.rowNumber}
              onClick={() => setEditingRow(r)}
              className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] cursor-pointer active:bg-cream transition-colors"
            >
              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                <span className="font-semibold text-sm text-foreground uppercase">{r.event}</span>
                {!r.hasAddress && <NoAddressIcon />}
                <span className="text-xs text-faint uppercase truncate">{displayIg(r.customer)}</span>
              </div>
              <div className="flex items-start justify-between gap-3 mt-2">
                <div className="text-sm text-foreground">{r.items}</div>
                <div className="shrink-0 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <CopyInvoiceButton customer={r.customer} event={r.event} />
                  <button
                    onClick={() => setDuplicatingRow(r)}
                    title="Duplicate as variant"
                    className="inline-flex items-center justify-center p-1 text-faint hover:text-brand transition-colors rounded"
                  >
                    <TagIcon />
                  </button>
                </div>
              </div>
              {r.note && <div className="text-xs text-faint italic mt-1">Note: {r.note}</div>}
              <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-cream-border">
                <span className="text-xs text-faint uppercase">
                  {bought ? "Purchased" : "Not purchased"}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground tabular-nums whitespace-nowrap">Rp {fmt(r.unitPrice * r.unit)}</span>
                  <span className="shrink-0 inline-flex items-center justify-center h-5 w-9 rounded-full text-[11px] font-bold bg-brand text-white">× {r.unit}</span>
                </div>
              </div>
            </div>
          )
        })}
        {totalCount > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-3 pt-1">
            <button type="button" disabled={pagination.pageIndex === 0} onClick={() => setPagination((p) => ({ ...p, pageIndex: p.pageIndex - 1 }))} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm text-muted-strong disabled:opacity-40">Prev</button>
            <span className="text-xs text-faint">Page {pagination.pageIndex + 1} of {Math.max(1, Math.ceil(totalCount / PAGE_SIZE))}</span>
            <button type="button" disabled={(pagination.pageIndex + 1) * PAGE_SIZE >= totalCount} onClick={() => setPagination((p) => ({ ...p, pageIndex: p.pageIndex + 1 }))} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm text-muted-strong disabled:opacity-40">Next</button>
          </div>
        )}
      </div>

      {/* Mobile add FAB */}
      <button type="button" onClick={() => setMobileAddOpen(true)} aria-label="Add order" className="md:hidden fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90">+</button>

      {/* Mobile add sheet */}
      {mobileAddOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40 flex flex-col justify-end" onClick={() => setMobileAddOpen(false)}>
          <div className="max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <AddOrderForm options={options} onOrderAdded={() => { setMobileAddOpen(false); refreshRef.current(); window.scrollTo({ top: 0, behavior: "smooth" }) }} onCancel={() => setMobileAddOpen(false)} />
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

      {duplicatingRow && (
        <DuplicateVariantModal
          row={duplicatingRow}
          onClose={() => setDuplicatingRow(null)}
          onDone={() => { setDuplicatingRow(null); refreshRef.current() }}
        />
      )}

      {/* For the inline cells. The modal carries its own, since it can be open
          over this one and each needs its own answer. */}
      {causeDialog}
    </div>
  )
}

// ---------------------------------------------------------------------------
// DuplicateVariantModal — same feature as order-requests' "Duplicate as
// variant": a size/colour note on this row's product ("Navy, size L") isn't
// its own sellable SKU until it has its own product row.
//
// The copy is made server-side, by id. This screen once fetched the source
// product's whole pricing row — store, cost, profit — and posted every field
// back unchanged, which meant only an owner could use the button at all: staff
// cannot be handed the margins in order to copy them. Nothing about the source
// reaches this component now; it sends which product and what to call the copy,
// and the server carries the rest across. Then the order line moves onto the
// new product with the same stage:"1" PUT EditOrderModal's item-change uses.
// ---------------------------------------------------------------------------

function DuplicateVariantModal({ row, onClose, onDone }: {
  row: FormRow
  onClose: () => void
  onDone: () => void
}) {
  // The table already shows the product's name, so the suggestion costs no
  // request — and the name is the only thing about the product this screen has
  // any business knowing.
  const [name, setName] = useState(
    row.note.trim() ? `${row.items} — ${row.note.trim()}` : row.items,
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  async function submit() {
    if (!name.trim()) { setError("Name is required"); return }
    setSubmitting(true); setError("")
    try {
      const productRes = await fetch("/api/sheets/products/variant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromProductId: row.productId, name: name.trim() }),
      })
      const productData = await productRes.json()
      if (!productRes.ok) throw new Error(productData.error ?? "Failed to create variant")

      const applyRes = await fetch(`/api/sheets/duplicate-form/${row.rowNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: "1",
          event: row.event,
          customer: row.customer,
          productId: productData.id,
          // The copy's price, as the server priced it — the same figure the
          // source carries, since every pricing input came across with it.
          unitPrice: productData.price,
          unit: row.unit,
          note: row.note,
        }),
      })
      const applyData = await applyRes.json()
      if (!applyRes.ok) throw new Error(applyData.error ?? "Failed to apply new product")
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl p-5 w-full max-w-md flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-foreground">Duplicate as variant</h3>
        {/* Store, cost and margin are carried across by the server and never
            shown: which shop a product came from is not staff's to know, and
            here every one of them is inherited rather than chosen, so there is
            nothing to decide by seeing them. The price is this order line's
            own, which the variant keeps — the customer is paying it either
            way, so it is the one figure worth confirming before saving. */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Price</span>
          <div className={`${INPUT_CLS} bg-surface-muted text-muted tabular-nums`}>Rp {fmt(row.unitPrice)}</div>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">New product name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT_CLS} />
        </label>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="px-4 py-2 rounded-lg bg-brand text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Create & apply"}
          </button>
        </div>
      </div>
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
        className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-faint hover:text-brand"
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
    return <span className="tabular-nums">{value == null ? <span className="text-faint">—</span> : fmt(value)}</span>
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
// EditableTextCell — inline note edit (available to any role) for the table
// ---------------------------------------------------------------------------

function EditableTextCell({ value, onSave }: {
  value: string
  onSave: (value: string) => Promise<void>
}) {
  // Mirrors EditableNumberCell: an internal draft so partial typing survives
  // re-renders, resynced only when the row's canonical value actually changes.
  const [draft, setDraft] = useState(value ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastValueRef = useRef(value)

  useEffect(() => {
    if (lastValueRef.current !== value) {
      lastValueRef.current = value
      setDraft(value ?? "")
    }
  }, [value])

  async function commit() {
    const next = draft.trim()
    if (next === (value ?? "").trim()) {
      setError(null)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setDraft(value ?? "")
    } finally {
      setSaving(false)
    }
  }

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur()
        if (e.key === "Escape") {
          setDraft(value ?? "")
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      disabled={saving}
      placeholder="—"
      title={error ?? undefined}
      className={`w-full bg-transparent border px-2 py-0.5 text-xs rounded transition-colors ${
        error
          ? "border-red-300 text-red-700"
          : "border-transparent hover:border-cream-border focus:border-brand focus:bg-white focus:outline-none"
      } disabled:opacity-50`}
    />
  )
}

// ---------------------------------------------------------------------------
// Edit Order Modal
// ---------------------------------------------------------------------------

/**
 * Save an edit, and ask once if it would leave bought units on nobody's order.
 *
 * A unit that was paid for is either on an order or on the shelf. When an edit
 * would leave it on neither the server refuses with 409 rather than saving,
 * because it cannot know which happened — the order shrank, or too many were
 * bought — and both end in the same place: the stock exists and belongs in
 * Inventory.
 */
async function putOrderEdit(
  rowNumber: number,
  payload: Record<string, unknown>,
  /**
   * How to ask why the order shrank. Resolves with the answer, or null to
   * abandon the edit. Passed in rather than prompted here because the question
   * is a dialog now, and a dialog lives in React while this does not.
   */
  askCause?: (units: number) => Promise<ShrinkCause | null>,
): Promise<{ banked: number }> {
  async function send(extra?: Record<string, unknown>) {
    return await fetch(`/api/sheets/duplicate-form/${rowNumber}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(extra ? { ...payload, ...extra } : payload),
    })
  }

  // A response body can be read exactly once. The stranded-units question read
  // it to see whether that was the refusal, and everything after re-read it to
  // find the message -- so the one 409 that is not a question, the shipped
  // guard, reported "body stream already read" instead of saying what the
  // guard actually said. Read once, pass the body along.
  let res = await send()
  let body: Record<string, unknown> = await res.json().catch(() => ({}))
  if (res.status === 409 && body.error === "stranded_units") {
    const n = Number(body.stranded) || 0
    // Both answers shelve the units; the answer is the record, not the gate.
    // Declining abandons the edit rather than saving it unexplained.
    const cause = askCause ? await askCause(n) : null
    if (!cause) throw new Error("Nothing was saved")
    res = await send({ bankStranded: true, cause })
    body = await res.json().catch(() => ({}))
  }
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : "Failed to save")
  return { banked: Number(body.banked) || 0 }
}

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
  // Mobile: the owner-only correction fields collapse behind a chevron; on
  // desktop (md+) they're always shown regardless of this flag.
  const [ownerOpen, setOwnerOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [confirmPriceOpen, setConfirmPriceOpen] = useState(false)
  const { ask: askCause, dialog: causeDialog } = useShrinkCause()
  // Same question as the add form asks: is this somebody who has walked away
  // from an order before.
  const { marks } = useHitAndRun()

  const customerOptions = useMemo(
    () => (options?.customers ?? []).map((c) => {
      const stamps = marks.get(handleKey(c))
      return {
        value: c,
        label: displayIg(c),
        meta: options?.customerMobiles?.[c] || undefined,
        badge: stamps?.length ? <HitAndRunFlag stamps={stamps} /> : undefined,
      }
    }),
    [options, marks],
  )
  const itemOptions = useMemo(
    // Inactive products are hidden from the Order-input item picker only.
    () => (options?.items ?? []).filter((it) => it.active).map((it) => ({
      value: String(it.id),
      label: it.name,
      meta: `Rp ${fmt(it.price)}`,
    })),
    [options],
  )

  // Price comparison: the order's stored unit price vs the currently-selected
  // product's current price. Both are already in memory (the row + the cached
  // useSheetOptions list), so this adds no queries. Note that saving already
  // overwrites unit_price with currentPrice (see handleSubmit) — this just makes
  // that visible and warns when the two differ.
  const currentPrice = options?.items.find((it) => it.id === Number(form.productId))?.price ?? 0
  const priceDiffers = currentPrice !== row.unitPrice

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    // When the product price has drifted from the order's saved price, saving
    // will overwrite unit_price — confirm that explicitly before proceeding.
    if (priceDiffers) { setConfirmPriceOpen(true); return }
    void performSave()
  }

  async function performSave() {
    setConfirmPriceOpen(false)
    setSaving(true); setError("")
    try {
      const pid = Number(form.productId)
      const product = options?.items.find((it) => it.id === pid)
      await putOrderEdit(row.rowNumber, {
        stage: "1",
        event: form.event,
        customer: form.customer,
        productId: pid,
        unitPrice: product?.price ?? 0,
        unit: Number(form.unit),
        note: form.note,
      }, askCause)

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
          await putOrderEdit(row.rowNumber, { stage: "owner_cell", column: p.column, value: p.value }, askCause)
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
    <>
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 md:items-center" onClick={onClose}>
      <div className="bg-white rounded-t-xl md:rounded-xl border-x border-t border-cream-border md:border shadow-xl w-full max-w-md p-6 pb-8 md:pb-6 max-h-[90vh] overflow-y-auto md:max-h-none md:overflow-visible" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4 -mx-6 px-6 border-b border-cream-border pb-3 md:mx-0 md:px-0 md:border-b-0 md:pb-0">
          <h3 className="text-base font-semibold text-foreground">Edit Order</h3>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-muted mb-1 block">Event</label>
            <EventSelect value={form.event} onChange={(v) => setForm((f) => ({ ...f, event: v }))} events={options?.activeEvents ?? []} />
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">Customer</label>
            <SearchableSelect
              value={form.customer}
              onChange={(v) => setForm((f) => ({ ...f, customer: v }))}
              options={customerOptions}
              placeholder="Search or type new customer..."
              allowNewValue
              searchMeta
            />
          </div>
          <div>
            <label className="text-xs text-muted mb-1 block">Item</label>
            <SearchableSelect
              value={form.productId}
              onChange={(v) => setForm((f) => ({ ...f, productId: v }))}
              options={itemOptions}
              placeholder="Search item..."
            />
          </div>
          <div className="rounded-lg border border-cream-border bg-surface-muted/60 px-3 py-2 text-xs space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-muted">Order unit price</span>
              <span className="tabular-nums font-medium text-foreground">{fmt(row.unitPrice)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Current product price</span>
              <span className={`tabular-nums font-medium ${priceDiffers ? "text-amber-700" : "text-foreground"}`}>{fmt(currentPrice)}</span>
            </div>
            {priceDiffers && (
              <div className="flex items-start gap-1.5 pt-1 text-amber-700">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4" /><path d="M12 17h.01" />
                </svg>
                <span>Price differs — saving will update this order&rsquo;s unit price to {fmt(currentPrice)}.</span>
              </div>
            )}
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-muted mb-1 block">Qty</label>
              <input type="number" min="0" value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} className={INPUT_CLS} />
            </div>
            <div className="flex-1">
              <label className="text-xs text-muted mb-1 block">Note</label>
              <input type="text" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="Optional" className={INPUT_CLS} />
            </div>
          </div>

          {isOwner && (
            <div className="flex flex-col gap-2 p-3 rounded-lg bg-surface-muted border border-cream-border">
              <button
                type="button"
                onClick={() => setOwnerOpen((o) => !o)}
                className="w-full flex items-center justify-between text-left md:cursor-default"
              >
                <span className="text-xs font-medium text-muted-strong">Manual correction</span>
                <svg className={`md:hidden w-4 h-4 text-faint transition-transform ${ownerOpen ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
              </button>
              <div className={ownerOpen ? "block" : "hidden md:block"}>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs text-muted mb-1 block">Buy</label>
                    <input type="number" min="0" value={unitBuy} onChange={(e) => setUnitBuy(e.target.value)} placeholder="—" className={INPUT_CLS} />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-muted mb-1 block">Arrive</label>
                    <input type="number" min="0" value={unitArrive} onChange={(e) => setUnitArrive(e.target.value)} placeholder="—" className={INPUT_CLS} />
                  </div>
                </div>
                <p className="text-[11px] text-faint mt-1.5">Leave blank to clear. Shipped and held units are managed from the Packing List page.</p>
                {(row.unitBuy ?? 0) > 0 && (
                  <ReturnToExcessControl row={row} onDone={() => { onSaved(); onClose() }} />
                )}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}

          <div className="flex items-center gap-2 pt-2">
            <button
              type="button"
              onClick={() => { onClose(); onDelete(row.rowNumber) }}
              aria-label="Delete"
              className="inline-flex items-center justify-center h-[38px] border border-cream-border rounded-lg px-3 text-sm text-faint hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" />
              </svg>
            </button>
            <button type="button" onClick={onClose} className="ml-auto px-4 py-2 text-sm rounded-lg border border-cream-border text-muted-strong hover:border-brand hover:text-brand transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-medium rounded-lg bg-brand text-white hover:bg-brand-dark transition-colors disabled:opacity-50">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>

    {/* Price-change confirmation — shown on save when the product price has
        drifted from the order's saved unit price. */}
    {confirmPriceOpen && (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4" onClick={() => setConfirmPriceOpen(false)}>
        <div className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-xs p-5" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-start gap-2 mb-3">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-600 shrink-0 mt-0.5">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4" /><path d="M12 17h.01" />
            </svg>
            <h3 className="text-sm font-semibold text-foreground">Update unit price?</h3>
          </div>
          <p className="text-xs text-muted-strong mb-4">
            The current product price (<span className="font-medium text-foreground tabular-nums">{fmt(currentPrice)}</span>) differs from
            this order&rsquo;s saved price (<span className="font-medium text-foreground tabular-nums">{fmt(row.unitPrice)}</span>).
            Saving will update this order&rsquo;s unit price to <span className="font-medium text-amber-700 tabular-nums">{fmt(currentPrice)}</span>.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmPriceOpen(false)} disabled={saving} className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
              Cancel
            </button>
            <button type="button" onClick={() => void performSave()} disabled={saving} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-dark disabled:opacity-50 transition-colors">
              {saving ? "Saving…" : "Save & update price"}
            </button>
          </div>
        </div>
      </div>
    )}
    {causeDialog}
    </>
  )
}

// ---------------------------------------------------------------------------
// Return-to-excess control (revert a mistaken order)
// ---------------------------------------------------------------------------

function ReturnToExcessControl({ row, onDone }: { row: FormRow; onDone: () => void }) {
  const bought = row.unitBuy ?? 0
  // Units already committed to this customer can't be reassigned to excess.
  const committed = Math.max(row.unitArrive ?? 0, (row.unitShip ?? 0) + (row.unitHold ?? 0))
  const maxRemovable = Math.max(0, row.unit - committed)

  const [open, setOpen] = useState(false)
  const [qty, setQty] = useState("1")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  const n = Math.floor(Number(qty) || 0)
  const valid = n >= 1 && n <= maxRemovable
  const newUnit = row.unit - n
  const excess = valid ? Math.max(0, bought - Math.max(0, newUnit)) : 0
  const willDelete = newUnit <= 0

  async function submit() {
    if (!valid) return
    setBusy(true); setErr("")
    try {
      const res = await fetch(`/api/sheets/duplicate-form/${row.rowNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: "return_excess", removeUnits: n }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? "Failed")
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed")
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 text-xs font-medium text-amber-700 hover:text-amber-800 hover:underline"
      >
        Return bought units to excess…
      </button>
    )
  }

  return (
    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 flex flex-col gap-2">
      <div className="text-[11px] text-amber-800">
        Bought {bought} · ordered {row.unit}
        {committed > 0 ? ` · ${committed} already arrived/shipped/held` : ""}
      </div>
      {maxRemovable === 0 ? (
        <p className="text-xs text-muted">All units are already arrived/shipped/held — nothing to return.</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-strong">Remove</label>
            <input
              type="number"
              min={1}
              max={maxRemovable}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className={`${INPUT_CLS} w-20`}
            />
            <span className="text-xs text-muted">unit(s) from this order</span>
          </div>
          <div className="text-[11px] text-muted-strong">
            {valid
              ? willDelete
                ? `Deletes this order; ${excess} bought unit(s) → excess for "${row.items}".`
                : `Order quantity → ${newUnit}; ${excess} bought unit(s) → excess for "${row.items}".`
              : `Enter a number between 1 and ${maxRemovable}.`}
          </div>
          {err && <p className="text-xs text-red-600">{err}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!valid || busy}
              onClick={submit}
              className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-medium hover:bg-amber-700 disabled:opacity-50 transition-colors"
            >
              {busy ? "Working…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); setErr("") }}
              className="px-3 py-1.5 text-xs text-muted hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add Order Form (above table)
// ---------------------------------------------------------------------------

let _addLineId = 0
function newAddLine() { return { id: _addLineId++, productId: "", customer: "", unit: "", note: "" } }

function AddOrderForm({ options, onOrderAdded, onCancel }: {
  options: SheetOptions | null
  onOrderAdded: () => void
  onCancel?: () => void
}) {
  const [event, setEvent] = useState("")
  // The side that does NOT repeat: the customer when entering one person's
  // several items, the item when entering one item's several customers.
  const [mode, setMode] = useState<OrderFormMode>("byCustomer")
  const [customer, setCustomer] = useState("")
  // Whether anybody named on this form has walked away from an order before.
  // Fetched once for the form, not per line: the same answer serves every name
  // on it, and asking per line would turn one scan into one per row.
  const { marks } = useHitAndRun()
  // What is in the customer fields right now. The select commits on blur, and
  // a warning that waits for blur arrives after the decision it was meant to
  // inform.
  const [typing, setTyping] = useState<Record<string, string>>({})
  const [fixedItem, setFixedItem] = useState("")
  const [lines, setLines] = useState([newAddLine()])
  const byItem = mode === "byItem"
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null)

  const customerOptions = useMemo(
    () => (options?.customers ?? []).map((c) => {
      const stamps = marks.get(handleKey(c))
      return {
        value: c,
        label: displayIg(c),
        meta: options?.customerMobiles?.[c] || undefined,
        badge: stamps?.length ? <HitAndRunFlag stamps={stamps} /> : undefined,
      }
    }),
    [options, marks],
  )
  const itemOptions = useMemo(
    // Inactive products are hidden from the Order-input item picker only.
    () => (options?.items ?? []).filter((it) => it.active).map((it) => ({
      value: String(it.id),
      label: it.name,
      meta: `Rp ${fmt(it.price)}`,
    })),
    [options],
  )

  // Names on this form that carry a mark. One row per person however many
  // lines they occupy -- the warning is about her, not about a line.
  const flagged = useMemo(() => {
    const names = byItem
      ? lines.map((l) => typing[`l${l.id}`] ?? l.customer)
      : [typing.main ?? customer]
    const seen = new Set<string>()
    const out: { who: string; stamps: string[] }[] = []
    for (const name of names) {
      for (const m of marksFor(marks, name ?? "")) {
        if (!m.exact || seen.has(m.who)) continue
        seen.add(m.who)
        out.push({ who: m.who, stamps: m.stamps })
      }
    }
    return out
  }, [byItem, lines, customer, marks, typing])

  function updateLine(id: number, field: "productId" | "customer" | "unit" | "note", value: string) {
    setLines((prev) => prev.map((l) => l.id === id ? { ...l, [field]: value } : l))
    setFeedback(null)
  }
  function addLine() { setLines((prev) => [...prev, newAddLine()]) }
  function removeLine(id: number) { setLines((prev) => prev.filter((l) => l.id !== id)) }

  // Whichever side repeats is the one every line must have.
  const canSubmit = Boolean(event) && Boolean(byItem ? fixedItem : customer) &&
    lines.length > 0 &&
    lines.every((l) => (byItem ? l.customer : l.productId) && l.unit && Number(l.unit) > 0)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true); setFeedback(null)
    try {
      const res = await fetch("/api/sheets/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: rowsFromForm({
            mode, event,
            fixed: byItem ? fixedItem : customer,
            lines,
            priceOf: (id) => options?.items.find((it) => it.id === id)?.price ?? 0,
          }),
        }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Failed to save") }
      const count = lines.length
      setFeedback({ type: "success", message: `${count} order${count === 1 ? "" : "s"} added` })
      setEvent(""); setCustomer(""); setFixedItem(""); setLines([newAddLine()])
      onOrderAdded()
    } catch (err) {
      setFeedback({ type: "error", message: err instanceof Error ? err.message : "Failed to save" })
    } finally {
      setSubmitting(false)
    }
  }

  const LABEL = "text-xs text-muted mb-1 block"

  return (
    <form onSubmit={handleSubmit} className="rounded-t-xl md:rounded-xl border-x border-t border-cream-border md:border bg-white p-5 pb-8 md:pb-5 flex flex-col gap-4">
      <div className="flex items-center justify-between -mx-5 px-5 border-b border-cream-border pb-3 md:mx-0 md:px-0 md:border-b-0 md:pb-0">
        <span className="text-base md:text-sm font-semibold text-foreground">Add Order</span>
      </div>

      {/* Which way round the order is entered. The two are transposes: the side
          named here is fixed, the other repeats down the lines. Same segmented
          bar as the receiving list's route tabs, so it is operated the same way. */}
      <div className="flex items-center gap-1 rounded-xl border border-cream-border bg-cream p-1">
        {([
          { key: "byCustomer", label: "Per customer" },
          { key: "byItem", label: "Per item" },
        ] as const).map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              if (mode === key) return
              // The fixed side of the old mode becomes a line field in the new
              // one and vice versa, so nothing carried over would mean what it
              // used to. Clearing beats silently re-labelling.
              setMode(key)
              setCustomer("")
              setFixedItem("")
              setLines([newAddLine()])
              setFeedback(null)
            }}
            className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              mode === key ? "bg-brand text-white" : "text-muted hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL}>Event <span className="text-brand">*</span></label>
          <EventSelect value={event} onChange={(v) => { setEvent(v); setFeedback(null) }} events={options?.activeEvents ?? []} placeholder="Select event…" />
        </div>
        <div>
          <label className={LABEL}>
            {byItem ? "Item" : "Customer"} <span className="text-brand">*</span>
          </label>
          {byItem ? (
            <SearchableSelect
              value={fixedItem}
              onChange={(v) => { setFixedItem(v); setFeedback(null) }}
              options={itemOptions}
              placeholder="Search item..."
            />
          ) : (
            <SearchableSelect
              value={customer}
              onChange={(v) => { setCustomer(v); setFeedback(null) }}
              onQueryChange={(q) => setTyping((t) => ({ ...t, main: q }))}
              options={customerOptions}
              placeholder="Search or type new customer..."
              allowNewValue
              searchMeta
            />
          )}
        </div>
      </div>

      {flagged.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 flex items-start gap-2.5">
          <span className="text-amber-700 text-sm leading-none mt-0.5">⚑</span>
          <div className="text-xs text-muted-strong">
            {flagged.map(({ who, stamps }) => (
              <div key={who}>
                <b className="text-foreground">{displayIg(who)}</b> — {stamps.join(", ")}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        {/* Rows, not cards. A border around every line drew three boxes to say
            one thing -- these are lines of the same order, and the numbering
            said so twice over. The column headings sit once, above them, and
            the remove sits at the end of the row it removes. */}
        <div className="space-y-2">
          {/* One line of headings for all three columns. Item(s) used to sit a
              row higher, level with nothing, while the columns it belongs to
              were labelled underneath it. */}
          <div className="grid grid-cols-[minmax(0,1fr)_3.25rem_5.25rem_1.25rem] sm:grid-cols-[1fr_auto_auto_auto] gap-2 sm:gap-3 mb-1">
            <span className={LABEL + " mb-0"}>
              {byItem ? "Customer(s)" : "Item(s)"} <span className="text-brand">*</span>
            </span>
            <span className={LABEL + " mb-0 sm:w-24"}>Qty</span>
            <span className={LABEL + " mb-0 sm:w-32"}>Note</span>
            <span />
          </div>
          {lines.map((line) => (
            <div key={line.id} className="grid grid-cols-[minmax(0,1fr)_3.25rem_5.25rem_1.25rem] sm:grid-cols-[1fr_auto_auto_auto] gap-2 sm:gap-3 items-center">
              {byItem ? (
                <SearchableSelect
                  value={line.customer}
                  onChange={(v) => updateLine(line.id, "customer", v)}
                  onQueryChange={(q) => setTyping((t) => ({ ...t, [`l${line.id}`]: q }))}
                  options={customerOptions}
                  placeholder="Search or type new customer..."
                  allowNewValue
                  searchMeta
                />
              ) : (
                <SearchableSelect
                  value={line.productId}
                  onChange={(v) => updateLine(line.id, "productId", v)}
                  options={itemOptions}
                  placeholder="Search item..."
                />
              )}
              <input type="number" min="1" value={line.unit} onChange={(e) => updateLine(line.id, "unit", e.target.value)} placeholder="Qty" className={`${INPUT_CLS} px-2 text-center sm:px-3 sm:text-left sm:w-24`} />
              <input type="text" value={line.note} onChange={(e) => updateLine(line.id, "note", e.target.value)} placeholder="Note" className={`${INPUT_CLS} px-2 sm:px-3 sm:w-32`} />
              {/* Holds its width whether or not it can be pressed, so a row
                  removed above does not shift every field left. */}
              <div className="flex justify-center">
                {lines.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeLine(line.id)}
                    className="text-faint hover:text-red-400 transition-colors"
                    aria-label="Remove"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={addLine}
            className="text-xs text-brand hover:underline self-start"
          >
            + Add {byItem ? "customer" : "item"}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 -mx-5 px-5 pt-4 border-t border-cream-border md:mx-0 md:px-0 md:pt-0 md:border-t-0">
        {feedback && <p className={`mr-auto text-xs ${feedback.type === "success" ? "text-green-600" : "text-red-600"}`}>{feedback.message}</p>}
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={submitting} className="px-4 py-2 rounded-lg border border-cream-border text-muted-strong text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={submitting || !canSubmit}
          className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? "Saving..." : "Submit"}
        </button>
      </div>
    </form>
  )
}
