"use client"

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import type { FormRow } from "@/lib/db"
import { useResizableColumns } from "@/hooks/useResizableColumns"
import { useSheetOptions } from "@/hooks/useSheetOptions"

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

type ColumnId =
  | "index" | "event" | "customer" | "items" | "unit" | "note"
  | "unitBuy" | "receipt" | "unitArrive" | "unitShip" | "unitHold"
  | "createdAt" | "updatedAt"

type ColumnDef = {
  id: ColumnId
  label: string
  locked?: boolean
  defaultVisible: boolean
  numeric?: boolean
  className?: string
}

const ALL_COLUMNS: ColumnDef[] = [
  { id: "index",      label: "#",           locked: true,  defaultVisible: true,  className: "w-8" },
  { id: "event",      label: "Event",                      defaultVisible: true  },
  { id: "customer",   label: "Customer",                   defaultVisible: true  },
  { id: "items",      label: "Item",        locked: true,  defaultVisible: true  },
  { id: "unit",       label: "Qty",                        defaultVisible: true,  numeric: true, className: "w-16" },
  { id: "unitBuy",    label: "Unit Buy",                   defaultVisible: true,  numeric: true, className: "w-20" },
  { id: "receipt",    label: "Receipt",                    defaultVisible: true  },
  { id: "unitArrive", label: "Arrive",                     defaultVisible: false, numeric: true, className: "w-16" },
  { id: "unitShip",   label: "Ship",                       defaultVisible: false, numeric: true, className: "w-16" },
  { id: "unitHold",   label: "Hold",                       defaultVisible: false, numeric: true, className: "w-16" },
  { id: "note",       label: "Note",                       defaultVisible: false },
  { id: "createdAt",  label: "Created At",                 defaultVisible: false },
  { id: "updatedAt",  label: "Updated At",                 defaultVisible: false },
]

function defaultVisibility(): Record<ColumnId, boolean> {
  const v = {} as Record<ColumnId, boolean>
  for (const col of ALL_COLUMNS) v[col.id] = col.defaultVisible
  return v
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const PAGE_SIZE = 30

type Filters = { event: string; customer: string; items: string }
type SortKey = "event" | "customer" | "items" | "unit" | "unitBuy" | "receipt" | "unitArrive" | "unitShip" | "unitHold" | "createdAt" | "updatedAt"
type SortDir = "asc" | "desc"
type SortConfig = { key: SortKey; direction: SortDir } | null

type State = {
  rows: FormRow[]
  totalCount: number
  totalPages: number
  currentPage: number
  filters: Filters
  sort: SortConfig
  search: string
  columnVisibility: Record<ColumnId, boolean>
}

type Action =
  | { type: "SET_PAGE_DATA"; rows: FormRow[]; totalCount: number; totalPages: number; page: number }
  | { type: "SET_PAGE"; page: number }
  | { type: "SET_FILTER"; field: keyof Filters; value: string }
  | { type: "CLEAR_FILTERS" }
  | { type: "SET_SORT"; key: SortKey; direction: SortDir }
  | { type: "TOGGLE_SORT"; key: SortKey }
  | { type: "CLEAR_SORT" }
  | { type: "SET_SEARCH"; value: string }
  | { type: "TOGGLE_COLUMN"; column: ColumnId }

const INITIAL: State = {
  rows: [],
  totalCount: 0,
  totalPages: 1,
  currentPage: 1,
  filters: { event: "", customer: "", items: "" },
  sort: null,
  search: "",
  columnVisibility: defaultVisibility(),
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "SET_PAGE_DATA":
      return { ...state, rows: action.rows, totalCount: action.totalCount, totalPages: action.totalPages, currentPage: action.page }
    case "SET_PAGE":
      return { ...state, currentPage: action.page }
    case "SET_FILTER":
      return { ...state, filters: { ...state.filters, [action.field]: action.value }, currentPage: 1 }
    case "CLEAR_FILTERS":
      return { ...state, filters: { event: "", customer: "", items: "" }, search: "", currentPage: 1 }
    case "SET_SORT":
      return { ...state, sort: { key: action.key, direction: action.direction }, currentPage: 1 }
    case "TOGGLE_SORT": {
      if (state.sort?.key === action.key) {
        const next = state.sort.direction === "asc" ? "desc" : "asc"
        return { ...state, sort: { key: action.key, direction: next }, currentPage: 1 }
      }
      return { ...state, sort: { key: action.key, direction: "asc" }, currentPage: 1 }
    }
    case "SET_SEARCH":
      return { ...state, search: action.value, currentPage: 1 }
    case "CLEAR_SORT":
      return { ...state, sort: null, currentPage: 1 }
    case "TOGGLE_COLUMN": {
      const col = ALL_COLUMNS.find((c) => c.id === action.column)
      if (!col || col.locked) return state
      return {
        ...state,
        columnVisibility: {
          ...state.columnVisibility,
          [action.column]: !state.columnVisibility[action.column],
        },
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SORTABLE_COLUMNS = new Set<ColumnId>([
  "event", "customer", "items", "unit", "unitBuy", "receipt",
  "unitArrive", "unitShip", "unitHold", "createdAt", "updatedAt",
])

function fmtNum(v: number | null): string {
  if (v == null) return "—"
  return String(v)
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const TOOLBAR_BTN =
  "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-cream-border rounded-lg hover:bg-cream transition-colors text-gray-600"

function SortIcon({ active, direction }: { active: boolean; direction?: SortDir }) {
  if (!active) {
    return (
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-300 group-hover:text-gray-400">
        <path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" />
      </svg>
    )
  }
  return direction === "asc" ? (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand">
      <path d="m7 9 5-5 5 5" />
    </svg>
  ) : (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand">
      <path d="m7 15 5 5 5-5" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function FormRecordsTable() {
  const [state, dispatch] = useReducer(reducer, INITIAL)
  const [fetchState, setFetchState] = useState({ loading: true, error: "" })
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const columnsRef = useRef<HTMLDivElement>(null)
  const filtersRef = useRef<HTMLDivElement>(null)
  const options = useSheetOptions()

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (columnsRef.current && !columnsRef.current.contains(e.target as Node)) setColumnsOpen(false)
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) setFiltersOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [])

  const fetchPage = useCallback(async (
    page: number,
    search: string,
    filters: Filters,
    sort: SortConfig,
  ) => {
    setFetchState({ loading: true, error: "" })
    const params = new URLSearchParams()
    params.set("page", String(page))
    params.set("pageSize", String(PAGE_SIZE))
    if (search) params.set("search", search)
    if (filters.event) params.set("event", filters.event)
    if (filters.customer) params.set("customer", filters.customer)
    if (filters.items) params.set("items", filters.items)
    if (sort) {
      params.set("sortKey", sort.key)
      params.set("sortDir", sort.direction)
    } else {
      params.set("newestFirst", "true")
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const res = await fetch(`/api/sheets/duplicate-form?${params}`, { signal: controller.signal, cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to load")
      dispatch({ type: "SET_PAGE_DATA", rows: data.rows, totalCount: data.totalCount, totalPages: data.totalPages, page: data.page })
      setFetchState({ loading: false, error: "" })
    } catch (err) {
      const msg = err instanceof Error && err.name === "AbortError"
        ? "Request timed out — please retry"
        : err instanceof Error ? err.message : "Failed to load"
      setFetchState({ loading: false, error: msg })
    } finally {
      clearTimeout(timer)
    }
  }, [])

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevSearchRef = useRef(state.search)

  useEffect(() => {
    if (prevSearchRef.current !== state.search) {
      prevSearchRef.current = state.search
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
      searchTimerRef.current = setTimeout(() => {
        fetchPage(1, state.search, state.filters, state.sort)
      }, 300)
      return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
    }
    fetchPage(state.currentPage, state.search, state.filters, state.sort)
  }, [state.currentPage, state.filters, state.sort, state.search, fetchPage])

  const visibleColumns = useMemo(
    () => ALL_COLUMNS.filter((c) => state.columnVisibility[c.id]),
    [state.columnVisibility],
  )

  const { widths, startResize } = useResizableColumns({
    index: 32, event: 100, customer: 130, items: 200, unit: 64,
    unitBuy: 80, receipt: 130, unitArrive: 64, unitShip: 64, unitHold: 64,
    note: 130, createdAt: 120, updatedAt: 120,
  })

  const pageStart = (state.currentPage - 1) * PAGE_SIZE

  const filterOptions = useMemo(() => ({
    events:    (options?.events ?? []).slice(),
    customers: (options?.customers ?? []).slice(),
    items:     (options?.items ?? []).map((it) => it.name),
  }), [options])

  const hasFilters = state.filters.event || state.filters.customer || state.filters.items || state.search
  const filterCount = [state.filters.event, state.filters.customer, state.filters.items].filter(Boolean).length
  const hiddenCount = ALL_COLUMNS.filter((c) => !c.locked && !state.columnVisibility[c.id]).length

  function cellValue(row: FormRow, col: ColumnDef) {
    switch (col.id) {
      case "event":      return row.event
      case "customer":   return row.customer
      case "items":      return row.items
      case "unit":       return row.unit
      case "note":       return row.note || "—"
      case "unitBuy":    return fmtNum(row.unitBuy)
      case "receipt":    return row.receipt || "—"
      case "unitArrive": return fmtNum(row.unitArrive)
      case "unitShip":   return fmtNum(row.unitShip)
      case "unitHold":   return fmtNum(row.unitHold)
      case "createdAt":  return row.createdAt
      case "updatedAt":  return row.updatedAt || "—"
      default:           return ""
    }
  }

  if (fetchState.loading && state.rows.length === 0) {
    return (
      <div className="rounded-xl border border-cream-border bg-white p-10 text-center text-sm text-gray-400">
        Loading…
      </div>
    )
  }

  if (fetchState.error) {
    return (
      <div className="rounded-xl border border-cream-border bg-white p-10 text-center text-sm text-red-500">
        {fetchState.error}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative flex-1 min-w-48 max-w-sm">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={state.search}
            onChange={(e) => dispatch({ type: "SET_SEARCH", value: e.target.value })}
            placeholder="Search…"
            className="w-full border border-cream-border rounded-lg pl-8 pr-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
          />
        </div>

        {/* Filters popover */}
        <div className="relative" ref={filtersRef}>
          <button
            type="button"
            onClick={() => setFiltersOpen((o) => !o)}
            className={`${TOOLBAR_BTN} ${filtersOpen ? "bg-cream border-brand/30" : ""}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
            Filters
            {filterCount > 0 && (
              <span className="ml-0.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-brand text-white text-[10px] font-semibold">
                {filterCount}
              </span>
            )}
          </button>

          {filtersOpen && (
            <div className="absolute left-0 top-full mt-1.5 z-30 w-64 rounded-xl border border-cream-border bg-white shadow-lg p-3 space-y-2.5">
              <FilterSelect
                label="Event"
                value={state.filters.event}
                options={filterOptions.events}
                onChange={(v) => dispatch({ type: "SET_FILTER", field: "event", value: v })}
              />
              <FilterSelect
                label="Customer"
                value={state.filters.customer}
                options={filterOptions.customers}
                onChange={(v) => dispatch({ type: "SET_FILTER", field: "customer", value: v })}
              />
              <FilterSelect
                label="Item"
                value={state.filters.items}
                options={filterOptions.items}
                onChange={(v) => dispatch({ type: "SET_FILTER", field: "items", value: v })}
              />
            </div>
          )}
        </div>

        {/* Columns popover */}
        <div className="relative" ref={columnsRef}>
          <button
            type="button"
            onClick={() => setColumnsOpen((o) => !o)}
            className={`${TOOLBAR_BTN} ${columnsOpen ? "bg-cream border-brand/30" : ""}`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="18" rx="1" /><rect x="14" y="3" width="7" height="18" rx="1" />
            </svg>
            Columns
            {hiddenCount > 0 && (
              <span className="ml-0.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-brand text-white text-[10px] font-semibold">
                {hiddenCount}
              </span>
            )}
          </button>

          {columnsOpen && (
            <div className="absolute right-0 top-full mt-1.5 z-30 w-48 rounded-xl border border-cream-border bg-white shadow-lg py-1.5">
              {ALL_COLUMNS.filter((c) => !c.locked).map((col) => (
                <button
                  key={col.id}
                  type="button"
                  onClick={() => dispatch({ type: "TOGGLE_COLUMN", column: col.id })}
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-gray-700 hover:bg-cream transition-colors"
                >
                  <span
                    className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                      state.columnVisibility[col.id]
                        ? "bg-brand border-brand"
                        : "border-gray-300"
                    }`}
                  >
                    {state.columnVisibility[col.id] && (
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </span>
                  {col.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Reload */}
        <button
          type="button"
          onClick={() => fetchPage(state.currentPage, state.search, state.filters, state.sort)}
          className={TOOLBAR_BTN}
          title="Reload"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M8 16H3v5" />
          </svg>
          Reload
        </button>

        {/* Clear filters */}
        {hasFilters && (
          <button
            type="button"
            onClick={() => dispatch({ type: "CLEAR_FILTERS" })}
            className="text-xs text-brand hover:underline"
          >
            Clear filters
          </button>
        )}

        <span className="ml-auto text-xs text-gray-400 shrink-0">
          {state.totalCount} {state.totalCount === 1 ? "row" : "rows"}
        </span>
      </div>

      {/* Sort bar */}
      {state.sort && (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>Sorted by</span>
          <span className="font-medium text-foreground">
            {ALL_COLUMNS.find((c) => c.id === state.sort?.key)?.label ?? state.sort.key}
          </span>
          <span>({state.sort.direction === "asc" ? "ascending" : "descending"})</span>
          <button
            type="button"
            onClick={() => dispatch({ type: "SET_SORT", key: state.sort!.key, direction: state.sort!.direction === "asc" ? "desc" : "asc" })}
            className="text-brand hover:underline"
          >
            Reverse
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: "CLEAR_SORT" })}
            className="text-gray-400 hover:text-red-400 hover:underline"
          >
            ×
          </button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
        {state.rows.length === 0 ? (
          <p className="px-5 py-10 text-sm text-gray-400 text-center">
            {hasFilters ? "No rows match the current filters." : "No records found."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
              <thead>
                <tr className="border-b border-cream-border text-left bg-cream">
                  {visibleColumns.map((col) => {
                    const sortable = SORTABLE_COLUMNS.has(col.id)
                    const isActive = state.sort?.key === col.id
                    return (
                      <th
                        key={col.id}
                        className={`px-4 py-3 text-xs font-medium text-gray-500 relative select-none ${sortable ? "cursor-pointer group hover:text-foreground" : ""} ${col.numeric ? "text-right" : ""}`}
                        style={{ width: widths[col.id] }}
                        onClick={sortable ? () => dispatch({ type: "TOGGLE_SORT", key: col.id as SortKey }) : undefined}
                      >
                        <span className="inline-flex items-center gap-1">
                          {col.label}
                          {sortable && (
                            <SortIcon active={isActive} direction={state.sort?.direction} />
                          )}
                        </span>
                        <div
                          onMouseDown={(e) => { e.stopPropagation(); startResize(col.id, e) }}
                          className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60"
                        />
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {state.rows.map((row, i) => (
                  <tr key={row.rowNumber} className="border-b border-cream-border last:border-0 hover:bg-cream/50 transition-colors">
                    {visibleColumns.map((col) => {
                      if (col.id === "index") {
                        return (
                          <td key={col.id} className="px-4 py-3 text-xs text-gray-400">
                            {pageStart + i + 1}
                          </td>
                        )
                      }
                      const v = cellValue(row, col)
                      return (
                        <td
                          key={col.id}
                          className={`px-4 py-3 ${col.numeric ? "text-right font-medium tabular-nums" : ""} ${v === "—" ? "text-gray-400" : "text-foreground"}`}
                        >
                          {v}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {state.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <span>Page</span>
            <PageJumpInput
              currentPage={state.currentPage}
              totalPages={state.totalPages}
              onJump={(p) => dispatch({ type: "SET_PAGE", page: p })}
            />
            <span>of {state.totalPages}</span>
          </div>
          <div className="flex items-center gap-1">
            <PaginationButton
              onClick={() => dispatch({ type: "SET_PAGE", page: state.currentPage - 1 })}
              disabled={state.currentPage === 1}
            >
              &#8592;
            </PaginationButton>
            {getPageNumbers(state.currentPage, state.totalPages).map((p, idx) =>
              p === "…" ? (
                <span key={`e-${idx}`} className="px-2 text-xs text-gray-400">…</span>
              ) : (
                <PaginationButton
                  key={p}
                  onClick={() => dispatch({ type: "SET_PAGE", page: p as number })}
                  active={p === state.currentPage}
                >
                  {p}
                </PaginationButton>
              ),
            )}
            <PaginationButton
              onClick={() => dispatch({ type: "SET_PAGE", page: state.currentPage + 1 })}
              disabled={state.currentPage === state.totalPages}
            >
              &#8594;
            </PaginationButton>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

function PaginationButton({ children, onClick, disabled = false, active = false }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; active?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`min-w-[2rem] h-8 px-2 text-xs rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        active ? "bg-brand text-white font-medium" : "border border-cream-border hover:bg-cream text-gray-600"
      }`}
    >
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

// ---------------------------------------------------------------------------
// FilterSelect helper
// ---------------------------------------------------------------------------

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="text-xs font-medium text-gray-500 mb-1 block">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-cream-border rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  )
}
