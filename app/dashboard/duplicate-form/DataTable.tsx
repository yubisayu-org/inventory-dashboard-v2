"use client"

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import type { FormRow, InvoiceResult, SheetOptions } from "@/lib/db"
import { useResizableColumns } from "@/hooks/useResizableColumns"
import SearchableSelect from "@/components/SearchableSelect"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { copyToClipboard } from "@/lib/clipboard"
import { useCopyFeedback } from "@/hooks/useCopyFeedback"

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

type ColumnId =
  | "index" | "event" | "customer" | "items" | "unit"
  | "note" | "createdAt" | "updatedAt"
  | "actions"

type ColumnDef = {
  id: ColumnId
  label: string
  locked?: boolean
  defaultVisible: boolean
  className?: string
}

const ALL_COLUMNS: ColumnDef[] = [
  { id: "index",     label: "#",          locked: true,  defaultVisible: true,  className: "w-8" },
  { id: "event",     label: "Event",                     defaultVisible: true  },
  { id: "customer",  label: "Customer",                  defaultVisible: true  },
  { id: "items",     label: "Item",       locked: true,  defaultVisible: true  },
  { id: "unit",      label: "Qty",                       defaultVisible: true,  className: "w-16" },
  { id: "note",      label: "Note",                      defaultVisible: false },
  { id: "createdAt", label: "Created At",                defaultVisible: false },
  { id: "updatedAt", label: "Updated At",                defaultVisible: false },
  { id: "actions",   label: "",           locked: true,  defaultVisible: true,  className: "w-16 text-right" },
]

function getVisibleColumns(visibility: Record<ColumnId, boolean>): ColumnDef[] {
  return ALL_COLUMNS.filter((col) => visibility[col.id])
}

function defaultVisibility(): Record<ColumnId, boolean> {
  const result = {} as Record<ColumnId, boolean>
  for (const col of ALL_COLUMNS) result[col.id] = col.defaultVisible
  return result
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25

type Filters    = { event: string; customer: string; items: string }
type SortKey    = "event" | "customer" | "items" | "unit" | "note" | "createdAt"
type SortDir    = "asc" | "desc"
type SortConfig = { key: SortKey; direction: SortDir } | null

const SORT_LABELS: Record<SortKey, string> = {
  event: "Event", customer: "Customer", items: "Item",
  unit: "Qty", note: "Note", createdAt: "Created At",
}

type TableState = {
  rows: FormRow[]
  busyRowNumber: number | null
  currentPage: number
  filters: Filters
  sort: SortConfig
  search: string
  addDrawerOpen: boolean
  columnVisibility: Record<ColumnId, boolean>
}

type TableAction =
  | { type: "SET_ROWS"; rows: FormRow[] }
  | { type: "BUSY_START"; rowNumber: number }
  | { type: "BUSY_END" }
  | { type: "APPLY_UPDATE"; rowNumber: number; patch: Partial<FormRow> }
  | { type: "REMOVE_ROW"; rowNumber: number }
  | { type: "SET_PAGE"; page: number }
  | { type: "SET_FILTER"; field: keyof Filters; value: string }
  | { type: "CLEAR_FILTERS" }
  | { type: "SET_SORT"; key: SortKey; direction: SortDir }
  | { type: "CLEAR_SORT" }
  | { type: "SET_SEARCH"; value: string }
  | { type: "TOGGLE_ADD_DRAWER" }
  | { type: "TOGGLE_COLUMN"; column: ColumnId }

const INITIAL_STATE: TableState = {
  rows: [],
  busyRowNumber: null,
  currentPage: 1,
  filters: { event: "", customer: "", items: "" },
  sort: null,
  search: "",
  addDrawerOpen: false,
  columnVisibility: defaultVisibility(),
}

function tableReducer(state: TableState, action: TableAction): TableState {
  switch (action.type) {
    case "SET_ROWS":
      return { ...state, rows: [...action.rows].reverse(), busyRowNumber: null, currentPage: 1 }
    case "BUSY_START":
      return { ...state, busyRowNumber: action.rowNumber }
    case "BUSY_END":
      return { ...state, busyRowNumber: null }
    case "APPLY_UPDATE":
      return {
        ...state,
        rows: state.rows.map((r) =>
          r.rowNumber === action.rowNumber ? { ...r, ...action.patch } : r,
        ),
      }
    case "REMOVE_ROW": {
      const rows = state.rows.filter((r) => r.rowNumber !== action.rowNumber)
      const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
      return { ...state, rows, currentPage: Math.min(state.currentPage, totalPages) }
    }
    case "SET_PAGE":
      return { ...state, currentPage: action.page }
    case "SET_FILTER":
      return { ...state, filters: { ...state.filters, [action.field]: action.value }, currentPage: 1 }
    case "CLEAR_FILTERS":
      return { ...state, filters: { event: "", customer: "", items: "" }, search: "", currentPage: 1 }
    case "SET_SORT":
      return { ...state, sort: { key: action.key, direction: action.direction }, currentPage: 1 }
    case "CLEAR_SORT":
      return { ...state, sort: null, currentPage: 1 }
    case "SET_SEARCH":
      return { ...state, search: action.value, currentPage: 1 }
    case "TOGGLE_ADD_DRAWER":
      return { ...state, addDrawerOpen: !state.addDrawerOpen }
    case "TOGGLE_COLUMN": {
      const col = ALL_COLUMNS.find((c) => c.id === action.column)
      if (!col || col.locked) return state
      return { ...state, columnVisibility: { ...state.columnVisibility, [action.column]: !state.columnVisibility[action.column] } }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applySearch(rows: FormRow[], search: string): FormRow[] {
  if (!search) return rows
  const q = search.toLowerCase()
  return rows.filter((r) =>
    r.event.toLowerCase().includes(q) ||
    r.customer.toLowerCase().includes(q) ||
    r.items.toLowerCase().includes(q) ||
    r.note.toLowerCase().includes(q) ||
    String(r.unit).includes(q),
  )
}

function applyFilters(rows: FormRow[], filters: Filters): FormRow[] {
  return rows.filter((r) => {
    if (filters.event    && r.event    !== filters.event)    return false
    if (filters.customer && r.customer !== filters.customer) return false
    if (filters.items    && r.items    !== filters.items)    return false
    return true
  })
}

function applySort(rows: FormRow[], sort: SortConfig): FormRow[] {
  if (!sort) return rows
  const { key, direction } = sort
  return [...rows].sort((a, b) => {
    if (key === "unit") return direction === "asc" ? a.unit - b.unit : b.unit - a.unit
    const aStr = String(a[key as keyof FormRow] ?? "").toLowerCase()
    const bStr = String(b[key as keyof FormRow] ?? "").toLowerCase()
    return direction === "asc" ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr)
  })
}

function uniqueSorted(rows: FormRow[], key: "event" | "customer" | "items"): string[] {
  return [...new Set(rows.map((r) => r[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b)) as string[]
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const INPUT_CLASS =
  "w-full border border-cream-border rounded-md px-2 py-1 text-sm text-foreground bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

const TOOLBAR_BTN =
  "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-cream-border rounded-lg hover:bg-cream transition-colors text-gray-600"

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type EditForm = { event: string; customer: string; items: string; unit: string; note: string }

export default function DataTable() {
  const [table, dispatch] = useReducer(tableReducer, INITIAL_STATE)
  const [fetchState, setFetchState] = useState<{ loading: boolean; error: string; refreshError: string }>({ loading: true, error: "", refreshError: "" })
  const options = useSheetOptions()
  const [editingRowNumber, setEditingRowNumber] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<EditForm | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState("")
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const showAllRef = useRef(false)

  const visibleColumns = useMemo(
    () => getVisibleColumns(table.columnVisibility),
    [table.columnVisibility],
  )

  const { widths, startResize } = useResizableColumns({
    checkbox: 32, index: 32, event: 100, customer: 130, items: 200,
    unit: 64, note: 130, createdAt: 120, updatedAt: 120, actions: 90,
  })

  const searchedRows = useMemo(() => applySearch(table.rows, table.search),     [table.rows, table.search])
  const filteredRows = useMemo(() => applyFilters(searchedRows, table.filters), [searchedRows, table.filters])
  const sortedRows   = useMemo(() => applySort(filteredRows, table.sort),        [filteredRows, table.sort])
  const totalPages   = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE))
  const pageStart    = (table.currentPage - 1) * PAGE_SIZE
  const pagedRows    = sortedRows.slice(pageStart, pageStart + PAGE_SIZE)

  const filterOptions = useMemo(() => ({
    events:    uniqueSorted(table.rows, "event"),
    customers: uniqueSorted(table.rows, "customer"),
    items:     uniqueSorted(table.rows, "items"),
  }), [table.rows])

  const hasActiveFilters  = table.filters.event || table.filters.customer || table.filters.items || table.search
  const activeFilterCount = [table.filters.event, table.filters.customer, table.filters.items].filter(Boolean).length

  const loadRows = useCallback(async (isRefresh = false) => {
    setFetchState((s) => ({ ...s, loading: true, refreshError: "" }))
    const url = showAllRef.current ? "/api/sheets/duplicate-form" : "/api/sheets/duplicate-form?limit=20"

    async function attempt(): Promise<FormRow[]> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      try {
        const res = await fetch(url, { signal: controller.signal, cache: "no-store" })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to load rows")
        return data.rows
      } finally {
        clearTimeout(timer)
      }
    }

    try {
      let rows: FormRow[]
      try {
        rows = await attempt()
      } catch {
        // First attempt failed — wait briefly then retry once silently
        await new Promise<void>((r) => setTimeout(r, 1_000))
        rows = await attempt()
      }
      dispatch({ type: "SET_ROWS", rows })
      setFetchState({ loading: false, error: "", refreshError: "" })
    } catch (err) {
      const msg =
        err instanceof Error && err.name === "AbortError"
          ? "Request timed out — please retry"
          : err instanceof Error ? err.message : "Failed to load rows"
      // On refresh, keep existing rows visible — only show inline warning
      if (isRefresh) setFetchState((s) => ({ ...s, loading: false, refreshError: msg }))
      else setFetchState({ loading: false, error: msg, refreshError: "" })
    }
  }, [])

  useEffect(() => {
    loadRows()
  }, [loadRows])

  useEffect(() => {
    setSelectedRows((prev) => (prev.size === 0 ? prev : new Set()))
  }, [table.currentPage, table.filters, table.search])

  function toggleRow(rowNumber: number) {
    setSelectedRows((prev) => {
      const next = new Set(prev)
      if (next.has(rowNumber)) next.delete(rowNumber)
      else next.add(rowNumber)
      return next
    })
  }

  const pageRowNumbers = useMemo(() => pagedRows.map((r) => r.rowNumber), [pagedRows])
  const allPageSelected = pageRowNumbers.length > 0 && pageRowNumbers.every((n) => selectedRows.has(n))

  function toggleAllPage() {
    setSelectedRows((prev) => {
      const next = new Set(prev)
      if (allPageSelected) pageRowNumbers.forEach((n) => next.delete(n))
      else pageRowNumbers.forEach((n) => next.add(n))
      return next
    })
  }

  async function handleBulkDelete() {
    if (selectedRows.size === 0) return
    if (!confirm(`Delete ${selectedRows.size} selected order${selectedRows.size === 1 ? "" : "s"}? This cannot be undone.`)) return
    setBulkDeleting(true)
    // Delete highest row numbers first to preserve sheet indices
    const sorted = [...selectedRows].sort((a, b) => b - a)
    if (editingRowNumber !== null && selectedRows.has(editingRowNumber)) cancelEdit()
    try {
      for (const rowNumber of sorted) {
        const res = await fetch(`/api/sheets/duplicate-form/${rowNumber}`, { method: "DELETE" })
        if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? `Failed to delete row ${rowNumber}`) }
        dispatch({ type: "REMOVE_ROW", rowNumber })
      }
      setSelectedRows(new Set())
    } catch (err) {
      alert(err instanceof Error ? err.message : "Bulk delete failed")
      await loadRows()
    } finally {
      setBulkDeleting(false)
    }
  }

  function startEdit(row: FormRow) {
    setEditingRowNumber(row.rowNumber)
    setEditForm({ event: row.event, customer: row.customer, items: row.items, unit: String(row.unit), note: row.note })
    setEditError("")
    if (table.addDrawerOpen) dispatch({ type: "TOGGLE_ADD_DRAWER" })
  }

  function cancelEdit() {
    setEditingRowNumber(null)
    setEditForm(null)
    setEditError("")
  }

  async function saveEdit(rowNumber: number) {
    if (!editForm) return
    setEditSaving(true); setEditError("")
    try {
      const res = await fetch(`/api/sheets/duplicate-form/${rowNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: "1", event: editForm.event, customer: editForm.customer, items: editForm.items, unit: Number(editForm.unit), note: editForm.note }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Failed to save") }
      dispatch({ type: "APPLY_UPDATE", rowNumber, patch: { event: editForm.event, customer: editForm.customer, items: editForm.items, unit: Number(editForm.unit), note: editForm.note } })
      cancelEdit()
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setEditSaving(false)
    }
  }

  async function handleDelete(rowNumber: number) {
    if (!confirm("Delete this order? This cannot be undone.")) return
    dispatch({ type: "BUSY_START", rowNumber })
    try {
      const res = await fetch(`/api/sheets/duplicate-form/${rowNumber}`, { method: "DELETE" })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Failed to delete") }
      if (editingRowNumber === rowNumber) cancelEdit()
      dispatch({ type: "REMOVE_ROW", rowNumber })
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete row")
    } finally {
      dispatch({ type: "BUSY_END" })
    }
  }

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------

  if (fetchState.loading && table.rows.length === 0) {
    return <div className="flex items-center justify-center py-24 text-gray-400 text-sm">Loading orders...</div>
  }

  if (fetchState.error) {
    return (
      <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-4 text-sm text-red-700">
        <p className="font-medium mb-1">Failed to load data</p>
        <p>{fetchState.error}</p>
        <button onClick={() => loadRows()} className="mt-3 text-sm underline hover:no-underline">Retry</button>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex gap-4 items-start">
      {/* ── Table panel ── */}
      <div className="flex-1 min-w-0 rounded-xl border border-cream-border bg-white overflow-hidden">

        {/* Toolbar */}
        <div className="px-4 py-3 border-b border-cream-border">
          <div className="flex items-center gap-2">
            <div className="relative flex-1 max-w-xs">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="text"
                value={table.search}
                onChange={(e) => dispatch({ type: "SET_SEARCH", value: e.target.value })}
                placeholder="Search orders..."
                className="w-full pl-8 pr-3 py-1.5 text-xs border border-cream-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
              />
            </div>

            <FilterPopover filters={table.filters} filterOptions={filterOptions} activeCount={activeFilterCount} dispatch={dispatch} />
            <SortPopover sort={table.sort} dispatch={dispatch} />
            <ColumnPopover columns={ALL_COLUMNS} visibility={table.columnVisibility} dispatch={dispatch} />

            <div className="flex-1" />

            {selectedRows.size > 0 && (
              <button
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-500 hover:bg-red-50 hover:border-red-400 transition-colors disabled:opacity-50"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                </svg>
                {bulkDeleting ? "Deleting…" : `Delete ${selectedRows.size}`}
              </button>
            )}

            <button
              onClick={() => {
                const next = !showAll
                setShowAll(next)
                showAllRef.current = next
                loadRows(true)
              }}
              className="shrink-0 text-xs text-gray-400 hover:text-brand transition-colors underline underline-offset-2"
            >
              {showAll ? "Last 20" : "Show all"}
            </button>

            <span className="text-xs text-gray-400 shrink-0">
              {sortedRows.length !== table.rows.length ? `${sortedRows.length} of ${table.rows.length}` : table.rows.length}{" "}
              {table.rows.length === 1 ? "order" : "orders"}
            </span>

            <button onClick={() => loadRows(true)} title="Refresh" className="p-1.5 text-gray-400 hover:text-brand transition-colors rounded">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-6.22-8.56" /><polyline points="21 3 21 9 15 9" />
              </svg>
            </button>

            <button
              onClick={() => { dispatch({ type: "TOGGLE_ADD_DRAWER" }); cancelEdit() }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors ${
                table.addDrawerOpen ? "bg-brand-light text-brand border border-brand/30" : "bg-brand text-white hover:bg-brand-hover"
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Add Order
            </button>
          </div>

          {hasActiveFilters && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
              {table.search           && <FilterChip label={`Search: "${table.search}"`}          onRemove={() => dispatch({ type: "SET_SEARCH", value: "" })} />}
              {table.filters.event    && <FilterChip label={`Event: ${table.filters.event}`}       onRemove={() => dispatch({ type: "SET_FILTER", field: "event",    value: "" })} />}
              {table.filters.customer && <FilterChip label={`Customer: ${table.filters.customer}`} onRemove={() => dispatch({ type: "SET_FILTER", field: "customer", value: "" })} />}
              {table.filters.items    && <FilterChip label={`Item: ${table.filters.items}`}        onRemove={() => dispatch({ type: "SET_FILTER", field: "items",    value: "" })} />}
              <button onClick={() => dispatch({ type: "CLEAR_FILTERS" })} className="text-xs text-gray-400 hover:text-brand transition-colors ml-1">Clear all</button>
            </div>
          )}
        </div>

        {/* Inline refresh error — shown when a background reload fails but rows are still visible */}
        {fetchState.refreshError && (
          <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-red-200 bg-red-50 text-xs text-red-600">
            <span>Refresh failed: {fetchState.refreshError}</span>
            <button onClick={() => loadRows(true)} className="underline hover:no-underline shrink-0">Retry</button>
          </div>
        )}

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
            <thead>
              <tr className="border-b border-cream-border bg-cream text-left">
                <th className="pl-3 pr-1 py-2 relative select-none" style={{ width: widths.checkbox }}>
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={toggleAllPage}
                    className="rounded border-gray-300 text-brand focus:ring-brand/30 cursor-pointer"
                  />
                  <div onMouseDown={(e) => startResize("checkbox", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                </th>
                {visibleColumns.map((col) => (
                  <th key={col.id} className={`px-3 py-2 text-xs font-medium text-gray-500 relative select-none ${col.className ?? ""}`} style={{ width: widths[col.id] }}>
                    {col.label}
                    <div onMouseDown={(e) => startResize(col.id, e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pagedRows.length === 0 ? (
                <tr>
                  <td colSpan={visibleColumns.length + 1} className="px-3 py-12 text-center text-gray-400 text-sm">
                    {table.rows.length === 0 ? "No orders found." : "No orders match the current filters."}
                  </td>
                </tr>
              ) : (
                pagedRows.map((row, i) => {
                  const busy      = table.busyRowNumber === row.rowNumber
                  const isEditing = editingRowNumber === row.rowNumber
                  const isSelected = selectedRows.has(row.rowNumber)
                  return (
                    <tr
                      key={row.rowNumber}
                      className={`border-b border-cream-border last:border-0 transition-colors ${
                        isEditing  ? "bg-brand-light/30" :
                        isSelected ? "bg-brand-light/20" :
                        busy       ? "opacity-50" :
                                     "hover:bg-cream/60"
                      }`}
                    >
                      <td className="pl-3 pr-1 align-middle py-2.5">
                        {!isEditing && (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleRow(row.rowNumber)}
                            disabled={busy}
                            className="rounded border-gray-300 text-brand focus:ring-brand/30 cursor-pointer"
                          />
                        )}
                      </td>
                      {visibleColumns.map((col) => (
                        <td
                          key={col.id}
                          className={`px-3 align-middle ${isEditing ? "py-1.5" : "py-2.5"} ${col.id === "actions" ? "text-right" : ""}`}
                        >
                          {isEditing && editForm ? (
                            <EditCell
                              col={col} editForm={editForm}
                              onChange={(patch) => setEditForm((f) => f ? { ...f, ...patch } : f)}
                              options={options} busy={editSaving} error={editError}
                              onSave={() => saveEdit(row.rowNumber)}
                              onCancel={cancelEdit}
                              onDelete={() => handleDelete(row.rowNumber)}
                              i={i} pageStart={pageStart}
                            />
                          ) : (
                            <ReadCell col={col} row={row} i={i} pageStart={pageStart} busy={busy} onDelete={handleDelete} onEdit={() => startEdit(row)} />
                          )}
                        </td>
                      ))}
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-cream-border">
            <div className="flex items-center gap-1.5 text-xs text-gray-400">
              <span>Page</span>
              <PageJumpInput
                currentPage={table.currentPage}
                totalPages={totalPages}
                onJump={(p) => dispatch({ type: "SET_PAGE", page: p })}
              />
              <span>of {totalPages}</span>
            </div>
            <div className="flex items-center gap-1">
              <PaginationButton onClick={() => dispatch({ type: "SET_PAGE", page: table.currentPage - 1 })} disabled={table.currentPage === 1}>←</PaginationButton>
              {getPageNumbers(table.currentPage, totalPages).map((p, idx) =>
                p === "…"
                  ? <span key={`e-${idx}`} className="px-2 text-xs text-gray-400">…</span>
                  : <PaginationButton key={p} onClick={() => dispatch({ type: "SET_PAGE", page: p as number })} active={p === table.currentPage}>{p}</PaginationButton>
              )}
              <PaginationButton onClick={() => dispatch({ type: "SET_PAGE", page: table.currentPage + 1 })} disabled={table.currentPage === totalPages}>→</PaginationButton>
            </div>
          </div>
        )}
      </div>

      {table.addDrawerOpen && (
        <AddOrderDrawer
          options={options}
          onClose={() => dispatch({ type: "TOGGLE_ADD_DRAWER" })}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Read-only cell renderer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Inline copy button for text values
// ---------------------------------------------------------------------------

function CopyableText({ text }: { text: string }) {
  const { copied, copy } = useCopyFeedback()

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation()
    await copy(text)
  }

  return (
    <span className="inline-flex items-center gap-1 group">
      <span className="text-foreground">{text}</span>
      <button
        type="button"
        onClick={handleCopy}
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
// Invoice copy button for each row
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

      // Use the most recent event — matches Invoice page which shows events newest-first
      const event = data.events[data.events.length - 1]
      if (!event) throw new Error(`No invoice found for ${row.customer}`)

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
    : status === "error"  ? "!"
    : undefined

  return (
    <button
      onClick={handleClick}
      disabled={status === "loading"}
      title={status === "error" ? state.message : "Copy invoice message"}
      className={`p-1 transition-colors rounded disabled:opacity-50 ${
        status === "copied" ? "text-green-600"
        : status === "error"  ? "text-red-500"
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
// Read-only cell renderer
// ---------------------------------------------------------------------------

function ReadCell({ col, row, i, pageStart, busy, onDelete, onEdit }: {
  col: ColumnDef
  row: FormRow
  i: number
  pageStart: number
  busy: boolean
  onDelete: (n: number) => void
  onEdit: () => void
}) {
  switch (col.id) {
    case "index":      return <span className="text-gray-400 text-xs">{pageStart + i + 1}</span>
    case "event":      return <span className="text-foreground">{row.event}</span>
    case "customer":   return <CopyableText text={row.customer} />
    case "items":      return <span className="text-foreground">{row.items}</span>
    case "unit":       return <span className="text-foreground">{row.unit}</span>
    case "note":       return <span className="text-gray-500 text-xs">{row.note || "—"}</span>
    case "createdAt":  return <span className="text-gray-400 text-xs whitespace-nowrap">{row.createdAt || "—"}</span>
    case "updatedAt":  return <span className="text-gray-400 text-xs whitespace-nowrap">{row.updatedAt || "—"}</span>
    case "actions":
      return busy ? (
        <span className="text-xs text-gray-400">…</span>
      ) : (
        <div className="flex items-center justify-end gap-1">
          <CopyInvoiceRowButton row={row} />
          <button onClick={onEdit} title="Edit" className="p-1 text-gray-400 hover:text-brand transition-colors rounded">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          <button onClick={() => onDelete(row.rowNumber)} title="Delete" className="p-1 text-gray-400 hover:text-red-500 transition-colors rounded">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
            </svg>
          </button>
        </div>
      )
    default: return null
  }
}

// ---------------------------------------------------------------------------
// Inline edit cell renderer
// ---------------------------------------------------------------------------

const EDIT_INPUT = "w-full border border-cream-border rounded-md px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

function EditCell({ col, editForm, onChange, options, busy, error, onSave, onCancel, onDelete, i, pageStart }: {
  col: ColumnDef
  editForm: EditForm
  onChange: (patch: Partial<EditForm>) => void
  options: SheetOptions | null
  busy: boolean
  error: string
  onSave: () => void
  onCancel: () => void
  onDelete: () => void
  i: number
  pageStart: number
}) {
  const customerOptions = useMemo(
    () => (options?.customers ?? []).map((c) => ({ value: c, label: c })),
    [options],
  )
  const itemOptions = useMemo(
    () => (options?.items ?? []).map((it) => ({ value: it.name, label: it.name, meta: it.store || undefined })),
    [options],
  )

  switch (col.id) {
    case "index":
      return <span className="text-gray-400 text-xs">{pageStart + i + 1}</span>
    case "event":
      return (
        <select value={editForm.event} onChange={(e) => onChange({ event: e.target.value })} className={EDIT_INPUT}>
          <option value="">Select...</option>
          {(options?.events ?? []).map((ev) => <option key={ev} value={ev}>{ev}</option>)}
        </select>
      )
    case "customer":
      return (
        <SearchableSelect
          value={editForm.customer}
          onChange={(v) => onChange({ customer: v })}
          options={customerOptions}
          placeholder="Search or type new customer..."
          allowNewValue
        />
      )
    case "items":
      return (
        <SearchableSelect
          value={editForm.items}
          onChange={(v) => onChange({ items: v })}
          options={itemOptions}
          placeholder="Search item..."
        />
      )
    case "unit":
      return (
        <input
          type="number" min="1" value={editForm.unit}
          onChange={(e) => onChange({ unit: e.target.value })}
          className={EDIT_INPUT}
          style={{ width: "4rem" }}
        />
      )
    case "note":
      return (
        <input
          type="text" value={editForm.note}
          onChange={(e) => onChange({ note: e.target.value })}
          placeholder="Optional"
          className={EDIT_INPUT}
        />
      )
    case "createdAt":
    case "updatedAt":
      return null
    case "actions":
      return (
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1.5">
            <button onClick={onSave} disabled={busy} className="text-xs text-brand font-medium hover:underline disabled:opacity-50">
              {busy ? "Saving…" : "Save"}
            </button>
            <button onClick={onCancel} className="text-xs text-gray-400 hover:underline">Cancel</button>
            <button onClick={onDelete} title="Delete" className="p-1 text-gray-400 hover:text-red-500 transition-colors rounded">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
              </svg>
            </button>
          </div>
          {error && <p className="text-[11px] text-red-500 text-right">{error}</p>}
        </div>
      )
    default: return null
  }
}

// ---------------------------------------------------------------------------
// Add Order Drawer
// ---------------------------------------------------------------------------

let _addLineId = 0
function newAddLine() { return { id: _addLineId++, items: "", unit: "", note: "" } }

function AddOrderDrawer({ options, onClose }: {
  options: SheetOptions | null
  onClose: () => void
}) {
  const [event, setEvent]       = useState("")
  const [customer, setCustomer] = useState("")
  const [lines, setLines]       = useState([newAddLine()])
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null)

  const customerOptions = useMemo(
    () => (options?.customers ?? []).map((c) => ({ value: c, label: c })),
    [options],
  )
  const itemOptions = useMemo(
    () => (options?.items ?? []).map((it) => ({ value: it.name, label: it.name, meta: it.store || undefined })),
    [options],
  )

  function updateLine(id: number, field: "items" | "unit" | "note", value: string) {
    setLines((prev) => prev.map((l) => l.id === id ? { ...l, [field]: value } : l))
    setFeedback(null)
  }
  function addLine()            { setLines((prev) => [...prev, newAddLine()]) }
  function removeLine(id: number) { setLines((prev) => prev.filter((l) => l.id !== id)) }

  const canSubmit = Boolean(event) && Boolean(customer) &&
    lines.length > 0 && lines.every((l) => l.items && l.unit && Number(l.unit) > 0)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true); setFeedback(null)
    try {
      const res = await fetch("/api/sheets/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: lines.map((l) => ({ event, customer, items: l.items, unit: Number(l.unit), note: l.note })),
        }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Failed to save") }
      const count = lines.length
      setFeedback({ type: "success", message: `${count} order${count === 1 ? "" : "s"} added — refresh to see` })
      setEvent(""); setCustomer(""); setLines([newAddLine()])
    } catch (err) {
      setFeedback({ type: "error", message: err instanceof Error ? err.message : "Failed to save" })
    } finally {
      setSubmitting(false)
    }
  }

  const LABEL  = "text-xs text-gray-500 mb-1 block"
  const DINPUT = "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

  return (
    <div className="w-80 shrink-0 rounded-xl border border-cream-border bg-white flex flex-col sticky top-6 max-h-[calc(100vh-6rem)] overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-cream-border sticky top-0 bg-white z-10">
        <h3 className="text-sm font-semibold text-foreground">New Order</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-brand transition-colors p-0.5 rounded">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <form onSubmit={handleSubmit} className="p-4 space-y-4">
        {/* Event */}
        <div>
          <label className={LABEL}>Event <span className="text-brand">*</span></label>
          <select value={event} onChange={(e) => { setEvent(e.target.value); setFeedback(null) }} required className={DINPUT}>
            <option value="">Select event...</option>
            {(options?.events ?? []).map((ev) => <option key={ev} value={ev}>{ev}</option>)}
          </select>
        </div>

        {/* Customer */}
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

        {/* Item lines */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className={LABEL + " mb-0"}>Items <span className="text-brand">*</span></label>
            <button type="button" onClick={addLine} className="text-xs text-brand hover:underline">+ Add item</button>
          </div>
          <div className="space-y-3">
            {lines.map((line, idx) => (
              <div key={line.id} className="rounded-lg border border-cream-border p-2.5 space-y-2 relative">
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
                <div>
                  <label className={LABEL}>Item {lines.length > 1 ? idx + 1 : ""}</label>
                  <SearchableSelect
                    value={line.items}
                    onChange={(v) => updateLine(line.id, "items", v)}
                    options={itemOptions}
                    placeholder="Search item..."
                  />
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className={LABEL}>Unit</label>
                    <input
                      type="number"
                      min="1"
                      value={line.unit}
                      onChange={(e) => updateLine(line.id, "unit", e.target.value)}
                      placeholder="Qty"
                      className={DINPUT}
                    />
                  </div>
                  <div className="flex-1">
                    <label className={LABEL}>Note</label>
                    <input
                      type="text"
                      value={line.note}
                      onChange={(e) => updateLine(line.id, "note", e.target.value)}
                      placeholder="Optional"
                      className={DINPUT}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {feedback && <p className={`text-xs ${feedback.type === "success" ? "text-green-600" : "text-red-600"}`}>{feedback.message}</p>}
        <button
          type="submit"
          disabled={submitting || !canSubmit}
          className="w-full py-2 text-sm font-medium rounded-lg bg-brand text-white hover:bg-brand-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Saving..." : `Submit ${lines.length > 1 ? `${lines.length} Orders` : "Order"}`}
        </button>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toolbar popovers
// ---------------------------------------------------------------------------

function FilterPopover({ filters, filterOptions, activeCount, dispatch }: {
  filters: Filters
  filterOptions: { events: string[]; customers: string[]; items: string[] }
  activeCount: number
  dispatch: React.Dispatch<TableAction>
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const fn = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener("mousedown", fn)
    return () => document.removeEventListener("mousedown", fn)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} className={TOOLBAR_BTN}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
        Filter
        {activeCount > 0 && <span className="ml-0.5 px-1.5 py-0.5 text-[10px] leading-none rounded-full bg-brand text-white font-medium">{activeCount}</span>}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-white border border-cream-border rounded-lg shadow-lg z-50 p-3 space-y-3">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Event</label>
            <SearchableSelect value={filters.event} onChange={(v) => dispatch({ type: "SET_FILTER", field: "event", value: v })} options={filterOptions.events.map((v) => ({ value: v, label: v }))} placeholder="All Events" clearable />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Customer</label>
            <SearchableSelect value={filters.customer} onChange={(v) => dispatch({ type: "SET_FILTER", field: "customer", value: v })} options={filterOptions.customers.map((v) => ({ value: v, label: v }))} placeholder="All Customers" clearable />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Item</label>
            <SearchableSelect value={filters.items} onChange={(v) => dispatch({ type: "SET_FILTER", field: "items", value: v })} options={filterOptions.items.map((v) => ({ value: v, label: v }))} placeholder="All Items" clearable />
          </div>
        </div>
      )}
    </div>
  )
}

function SortPopover({ sort, dispatch }: { sort: SortConfig; dispatch: React.Dispatch<TableAction> }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const fn = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener("mousedown", fn)
    return () => document.removeEventListener("mousedown", fn)
  }, [open])

  const sortKeys: SortKey[] = ["event", "customer", "items", "unit", "note", "createdAt"]

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} className={TOOLBAR_BTN}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m3 8 4-4 4 4" /><path d="M7 4v16" /><path d="M17 20V4" /><path d="m13 16 4 4 4-4" />
        </svg>
        {sort ? `${SORT_LABELS[sort.key]} ${sort.direction === "asc" ? "A→Z" : "Z→A"}` : "Sort"}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-white border border-cream-border rounded-lg shadow-lg z-50 p-3 space-y-3">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Column</label>
            <select
              value={sort?.key ?? ""}
              onChange={(e) => e.target.value ? dispatch({ type: "SET_SORT", key: e.target.value as SortKey, direction: sort?.direction ?? "asc" }) : dispatch({ type: "CLEAR_SORT" })}
              className={INPUT_CLASS}
            >
              <option value="">None</option>
              {sortKeys.map((k) => <option key={k} value={k}>{SORT_LABELS[k]}</option>)}
            </select>
          </div>
          {sort && (
            <div>
              <label className="text-xs text-gray-500 mb-1.5 block">Direction</label>
              <div className="flex gap-2">
                {(["asc", "desc"] as const).map((dir) => (
                  <button key={dir} type="button" onClick={() => dispatch({ type: "SET_SORT", key: sort.key, direction: dir })}
                    className={`flex-1 px-2 py-1.5 text-xs rounded-md border transition-colors ${sort.direction === dir ? "border-brand bg-brand-light text-brand font-medium" : "border-cream-border hover:bg-cream text-gray-600"}`}>
                    {sort.key === "unit" ? (dir === "asc" ? "1 → 9" : "9 → 1") : (dir === "asc" ? "A → Z" : "Z → A")}
                  </button>
                ))}
              </div>
            </div>
          )}
          {sort && (
            <button type="button" onClick={() => { dispatch({ type: "CLEAR_SORT" }); setOpen(false) }} className="w-full text-xs text-gray-400 hover:text-brand transition-colors text-center pt-1">
              Remove sort
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ColumnPopover({ columns, visibility, dispatch }: {
  columns: ColumnDef[]
  visibility: Record<ColumnId, boolean>
  dispatch: React.Dispatch<TableAction>
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const fn = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener("mousedown", fn)
    return () => document.removeEventListener("mousedown", fn)
  }, [open])

  const toggleable = columns.filter((c) => !c.locked)

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} className={TOOLBAR_BTN}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0 0h18" />
        </svg>
        Columns
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-52 bg-white border border-cream-border rounded-lg shadow-lg z-50 py-2">
          <p className="px-3 pb-2 text-xs text-gray-400 border-b border-cream-border">Toggle columns</p>
          <div className="py-1 max-h-72 overflow-y-auto">
            {toggleable.map((col) => (
              <label key={col.id} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-cream cursor-pointer">
                <input type="checkbox" checked={visibility[col.id]} onChange={() => dispatch({ type: "TOGGLE_COLUMN", column: col.id })} className="accent-brand rounded" />
                <span className="text-xs text-foreground">{col.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filter Chip
// ---------------------------------------------------------------------------

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-cream border border-cream-border text-foreground">
      {label}
      <button type="button" onClick={onRemove} className="text-gray-400 hover:text-brand transition-colors ml-0.5">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function PaginationButton({ children, onClick, disabled = false, active = false }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; active?: boolean
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`min-w-[2rem] h-8 px-2 text-xs rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${active ? "bg-brand text-white font-medium" : "border border-cream-border hover:bg-cream text-gray-600"}`}>
      {children}
    </button>
  )
}

function PageJumpInput({ currentPage, totalPages, onJump }: {
  currentPage: number
  totalPages: number
  onJump: (page: number) => void
}) {
  const [value, setValue] = useState(String(currentPage))

  useEffect(() => { setValue(String(currentPage)) }, [currentPage])

  function commit() {
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1) {
      setValue(String(currentPage))
      return
    }
    const clamped = Math.min(totalPages, Math.max(1, n))
    if (clamped !== currentPage) onJump(clamped)
    else setValue(String(currentPage))
  }

  return (
    <input
      type="number"
      min={1}
      max={totalPages}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur() }
      }}
      aria-label="Jump to page"
      className="w-12 text-center border border-cream-border rounded-md px-1 py-1 text-xs text-foreground bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
    />
  )
}

function getPageNumbers(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages: (number | "…")[] = [1]
  if (current > 3) pages.push("…")
  const start = Math.max(2, current - 1)
  const end   = Math.min(total - 1, current + 1)
  for (let p = start; p <= end; p++) pages.push(p)
  if (current < total - 2) pages.push("…")
  pages.push(total)
  return pages
}
