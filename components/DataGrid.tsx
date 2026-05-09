"use client"

import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type VisibilityState,
  type FilterFn,
  type Column,
  type Table as TanTable,
  type Row,
} from "@tanstack/react-table"
import { useState, useRef, useEffect, useCallback, useMemo } from "react"

// ─── Filter functions ──────────────────────────────────────────────────────

const numericFilter: FilterFn<unknown> = (row, columnId, filterValue) => {
  const val = row.getValue<number>(columnId)
  if (val == null) return false
  const { op, value } = filterValue as { op: string; value: number }
  if (value == null || isNaN(value)) return true
  switch (op) {
    case "eq": return val === value
    case "gt": return val > value
    case "lt": return val < value
    case "gte": return val >= value
    case "lte": return val <= value
    default: return true
  }
}
numericFilter.autoRemove = (val) => !val || val.value == null || val.value === "" || isNaN(val.value)

const textContainsFilter: FilterFn<unknown> = (row, columnId, filterValue) => {
  const val = row.getValue<string>(columnId)
  if (!filterValue) return true
  return String(val ?? "").toLowerCase().includes(String(filterValue).toLowerCase())
}
textContainsFilter.autoRemove = (val) => !val || val === ""

const booleanFilter: FilterFn<unknown> = (row, columnId, filterValue) => {
  const val = row.getValue<boolean>(columnId)
  if (filterValue === "true") return val === true
  if (filterValue === "false") return val === false
  return true
}
booleanFilter.autoRemove = (val) => !val || val === ""

export { numericFilter, textContainsFilter, booleanFilter }

// ─── Types ─────────────────────────────────────────────────────────────────

export type { ColumnDef, Row }

interface DataGridProps<T> {
  data: T[]
  columns: ColumnDef<T, unknown>[]
  pageSize?: number
  /** Global search placeholder */
  searchPlaceholder?: string
  /** Extra toolbar content rendered before the column visibility button */
  toolbarExtra?: React.ReactNode
  /** Row key accessor — defaults to (row) => row.id */
  getRowId?: (row: T) => string
  /** Optional initial column visibility */
  initialVisibility?: VisibilityState
  /** Optional initial sorting */
  initialSorting?: SortingState
}

// ─── Component ─────────────────────────────────────────────────────────────

export default function DataGrid<T>({
  data,
  columns,
  pageSize = 25,
  searchPlaceholder = "Search…",
  toolbarExtra,
  getRowId,
  initialVisibility,
  initialSorting,
}: DataGridProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting ?? [])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(initialVisibility ?? {})
  const [globalFilter, setGlobalFilter] = useState("")

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, columnVisibility, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: getRowId as ((row: T) => string) | undefined,
    initialState: { pagination: { pageSize } },
    filterFns: { numeric: numericFilter, textContains: textContainsFilter, boolean: booleanFilter },
  })

  const totalRows = table.getFilteredRowModel().rows.length
  const pageCount = table.getPageCount()
  const currentPage = table.getState().pagination.pageIndex + 1

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Global search */}
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder={searchPlaceholder}
            className="border border-cream-border rounded-lg pl-8 pr-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors w-56"
          />
        </div>

        {/* Active filters */}
        <ActiveFilters table={table} />

        {toolbarExtra}

        <div className="flex-1" />

        <span className="text-xs text-gray-400">{totalRows} rows</span>

        {/* Column visibility */}
        <ColumnVisibilityMenu table={table} />
      </div>

      {/* Table */}
      <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ tableLayout: "auto" }}>
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="text-left text-xs text-gray-500 border-b border-cream-border bg-cream">
                  {hg.headers.map((header) => {
                    const align = (header.column.columnDef.meta as { align?: string } | undefined)?.align
                    return (
                    <th key={header.id} className={`px-4 py-3 font-medium relative select-none group ${align === "right" ? "text-right" : ""}`} style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}>
                      <div className={`flex items-center gap-1 ${align === "right" ? "justify-end" : ""}`}>
                        {header.isPlaceholder ? null : (
                          <>
                            <span
                              className={header.column.getCanSort() ? "cursor-pointer hover:text-brand transition-colors" : ""}
                              onClick={header.column.getToggleSortingHandler()}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                            </span>
                            {header.column.getIsSorted() === "asc" && (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-brand shrink-0"><path d="M12 19V5m-7 7 7-7 7 7" /></svg>
                            )}
                            {header.column.getIsSorted() === "desc" && (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-brand shrink-0"><path d="M12 5v14m7-7-7 7-7-7" /></svg>
                            )}
                            {header.column.getCanFilter() && (
                              <ColumnFilterButton column={header.column} />
                            )}
                          </>
                        )}
                      </div>
                    </th>
                    )
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td colSpan={table.getVisibleLeafColumns().length} className="px-4 py-12 text-center text-gray-400 text-sm">
                    No data found.
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="border-b border-cream-border/60 hover:bg-cream/30 transition-colors">
                    {row.getVisibleCells().map((cell) => {
                      const align = (cell.column.columnDef.meta as { align?: string } | undefined)?.align
                      return (
                        <td key={cell.id} className={`px-4 py-3 ${align === "right" ? "text-right" : ""}`}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      )
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {pageCount > 1 && (
        <Pagination table={table} currentPage={currentPage} pageCount={pageCount} />
      )}
    </div>
  )
}

// ─── Column filter button ──────────────────────────────────────────────────

function ColumnFilterButton<T>({ column }: { column: Column<T, unknown> }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const isFiltered = column.getIsFiltered()

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [open])

  const filterFnName = (column.columnDef as { filterFn?: string }).filterFn
  const isNumeric = filterFnName === "numeric"
  const isBoolean = filterFnName === "boolean"

  return (
    <div className="relative inline-flex">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`p-0.5 rounded transition-colors ${isFiltered ? "text-brand" : "text-gray-300 opacity-0 group-hover:opacity-100 hover:text-brand"}`}
        title="Filter column"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
      </button>

      {open && (
        <div ref={ref} className="absolute top-full left-0 mt-1 z-50 bg-white border border-cream-border rounded-lg shadow-lg p-3 min-w-[200px]">
          {isBoolean ? (
            <BooleanFilterInput column={column} onClose={() => setOpen(false)} />
          ) : isNumeric ? (
            <NumericFilterInput column={column} onClose={() => setOpen(false)} />
          ) : (
            <TextFilterInput column={column} onClose={() => setOpen(false)} />
          )}
        </div>
      )}
    </div>
  )
}

// ─── Filter inputs ─────────────────────────────────────────────────────────

function TextFilterInput<T>({ column, onClose }: { column: Column<T, unknown>; onClose: () => void }) {
  const currentValue = (column.getFilterValue() as string) ?? ""
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-gray-500">Filter: contains</span>
      <input
        ref={inputRef}
        type="text"
        value={currentValue}
        onChange={(e) => column.setFilterValue(e.target.value || undefined)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") onClose() }}
        placeholder="Type to filter…"
        className="border border-cream-border rounded-md px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
      />
      {currentValue && (
        <button
          type="button"
          onClick={() => { column.setFilterValue(undefined); onClose() }}
          className="text-xs text-gray-400 hover:text-brand transition-colors text-left"
        >
          Clear filter
        </button>
      )}
    </div>
  )
}

function NumericFilterInput<T>({ column, onClose }: { column: Column<T, unknown>; onClose: () => void }) {
  const current = (column.getFilterValue() as { op: string; value: number | "" } | undefined) ?? { op: "eq", value: "" }
  const [op, setOp] = useState(current.op || "eq")
  const [value, setValue] = useState(String(current.value ?? ""))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const apply = useCallback(() => {
    const n = Number(value)
    if (value === "" || isNaN(n)) column.setFilterValue(undefined)
    else column.setFilterValue({ op, value: n })
  }, [op, value, column])

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-gray-500">Filter</span>
      <select
        value={op}
        onChange={(e) => { setOp(e.target.value); setTimeout(apply) }}
        className="border border-cream-border rounded-md px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-brand/30"
      >
        <option value="eq">equals</option>
        <option value="gt">greater than</option>
        <option value="lt">less than</option>
        <option value="gte">≥ greater or equal</option>
        <option value="lte">≤ less or equal</option>
      </select>
      <input
        ref={inputRef}
        type="number"
        value={value}
        onChange={(e) => { setValue(e.target.value); }}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === "Enter") { apply(); onClose() }
          if (e.key === "Escape") onClose()
        }}
        placeholder="Value"
        className="border border-cream-border rounded-md px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
      />
      {(current.value !== "" && current.value != null) && (
        <button
          type="button"
          onClick={() => { column.setFilterValue(undefined); onClose() }}
          className="text-xs text-gray-400 hover:text-brand transition-colors text-left"
        >
          Clear filter
        </button>
      )}
    </div>
  )
}

function BooleanFilterInput<T>({ column, onClose }: { column: Column<T, unknown>; onClose: () => void }) {
  const current = (column.getFilterValue() as string) ?? ""

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-gray-500">Filter</span>
      <select
        value={current}
        onChange={(e) => { column.setFilterValue(e.target.value || undefined); onClose() }}
        className="border border-cream-border rounded-md px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-brand/30"
      >
        <option value="">All</option>
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    </div>
  )
}

// ─── Active filters chips ──────────────────────────────────────────────────

function ActiveFilters<T>({ table }: { table: TanTable<T> }) {
  const filters = table.getState().columnFilters
  if (filters.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {filters.map((f) => {
        const col = table.getColumn(f.id)
        if (!col) return null
        const header = typeof col.columnDef.header === "string" ? col.columnDef.header : f.id
        let label: string
        if (typeof f.value === "object" && f.value !== null && "op" in f.value) {
          const { op, value } = f.value as { op: string; value: number }
          const opLabels: Record<string, string> = { eq: "=", gt: ">", lt: "<", gte: "≥", lte: "≤" }
          label = `${header} ${opLabels[op] ?? op} ${value}`
        } else if (f.value === "true" || f.value === "false") {
          label = `${header}: ${f.value}`
        } else {
          label = `${header}: "${f.value}"`
        }
        return (
          <span key={f.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-brand-light text-brand text-[11px] font-medium">
            {label}
            <button
              type="button"
              onClick={() => col.setFilterValue(undefined)}
              className="hover:text-red-500 transition-colors"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </span>
        )
      })}
      {filters.length > 1 && (
        <button
          type="button"
          onClick={() => table.resetColumnFilters()}
          className="text-[11px] text-gray-400 hover:text-brand transition-colors"
        >
          Clear all
        </button>
      )}
    </div>
  )
}

// ─── Column visibility ─────────────────────────────────────────────────────

function ColumnVisibilityMenu<T>({ table }: { table: TanTable<T> }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [open])

  const allColumns = table.getAllLeafColumns().filter((c) => c.getCanHide())

  if (allColumns.length === 0) return null

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-brand transition-colors px-3 py-1.5 rounded-lg border border-cream-border hover:border-brand"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        Columns
      </button>

      {open && (
        <div ref={ref} className="absolute right-0 top-full mt-1 z-50 bg-white border border-cream-border rounded-lg shadow-lg p-2 min-w-[180px] max-h-80 overflow-y-auto">
          {allColumns.map((col) => {
            const header = typeof col.columnDef.header === "string" ? col.columnDef.header : col.id
            return (
              <label key={col.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-cream cursor-pointer text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={col.getIsVisible()}
                  onChange={col.getToggleVisibilityHandler()}
                  className="rounded border-cream-border text-brand focus:ring-brand/30"
                />
                {header}
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Pagination ────────────────────────────────────────────────────────────

function Pagination<T>({ table, currentPage, pageCount }: { table: TanTable<T>; currentPage: number; pageCount: number }) {
  const pages = useMemo(() => getPageNumbers(currentPage, pageCount), [currentPage, pageCount])

  return (
    <div className="flex items-center justify-center gap-1.5 flex-wrap">
      <PgBtn onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()}>«</PgBtn>
      <PgBtn onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>‹</PgBtn>
      {pages.map((n, i) =>
        n === "…" ? (
          <span key={`e${i}`} className="px-1 text-gray-400 text-xs">…</span>
        ) : (
          <PgBtn key={n} onClick={() => table.setPageIndex(n - 1)} active={n === currentPage}>{n}</PgBtn>
        ),
      )}
      <PgBtn onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>›</PgBtn>
      <PgBtn onClick={() => table.setPageIndex(pageCount - 1)} disabled={!table.getCanNextPage()}>»</PgBtn>
      <JumpInput currentPage={currentPage} totalPages={pageCount} onJump={(p) => table.setPageIndex(p - 1)} />
      <span className="text-xs text-gray-400 ml-1">of {pageCount}</span>
    </div>
  )
}

function PgBtn({ children, onClick, disabled = false, active = false }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; active?: boolean
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`min-w-[2rem] h-8 px-2 text-xs rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${active ? "bg-brand text-white font-medium" : "border border-cream-border hover:bg-cream text-gray-600"}`}>
      {children}
    </button>
  )
}

function JumpInput({ currentPage, totalPages, onJump }: { currentPage: number; totalPages: number; onJump: (p: number) => void }) {
  const [value, setValue] = useState(String(currentPage))
  useEffect(() => { setValue(String(currentPage)) }, [currentPage])

  function commit() {
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1) { setValue(String(currentPage)); return }
    const clamped = Math.min(totalPages, Math.max(1, n))
    if (clamped !== currentPage) onJump(clamped)
    else setValue(String(currentPage))
  }

  return (
    <input type="number" min={1} max={totalPages} value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur() } }}
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
  const end = Math.min(total - 1, current + 1)
  for (let p = start; p <= end; p++) pages.push(p)
  if (current < total - 2) pages.push("…")
  pages.push(total)
  return pages
}
