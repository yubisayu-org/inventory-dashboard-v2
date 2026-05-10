"use client"

import { useCallback, useMemo, useState } from "react"
import type { FormRow } from "@/lib/db"
import { usePaginatedFetch, type PageData } from "@/hooks/usePaginatedFetch"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import DataGrid, {
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type PaginationState,
} from "@/components/DataGrid"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 30

function fmtNum(v: number | null): string {
  if (v == null) return "—"
  return String(v)
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function FormRecordsTable() {
  const options = useSheetOptions()

  // -- Server-side state --
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState("")
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE })

  // -- Data --
  const [rows, setRows] = useState<FormRow[]>([])
  const [totalCount, setTotalCount] = useState(0)

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

  // -- Column definitions --
  const columns: ColumnDef<FormRow, unknown>[] = useMemo(() => [
    {
      accessorKey: "event",
      header: "Event",
      filterFn: "textContains" as unknown as undefined,
    },
    {
      accessorKey: "customer",
      header: "Customer",
      filterFn: "textContains" as unknown as undefined,
    },
    {
      accessorKey: "items",
      header: "Item",
      filterFn: "textContains" as unknown as undefined,
      enableHiding: false,
    },
    {
      accessorKey: "unit",
      header: "Qty",
      enableColumnFilter: false,
      size: 80,
      meta: { align: "right" },
    },
    {
      accessorKey: "unitBuy",
      header: "Unit Buy",
      enableColumnFilter: false,
      size: 80,
      meta: { align: "right" },
      cell: ({ getValue }) => {
        const v = fmtNum(getValue<number | null>())
        return <span className={v === "—" ? "text-gray-400" : "font-medium tabular-nums"}>{v}</span>
      },
    },
    {
      accessorKey: "receipt",
      header: "Receipt",
      enableColumnFilter: false,
      cell: ({ getValue }) => {
        const v = getValue<string>()
        return <span className={v ? "" : "text-gray-400"}>{v || "—"}</span>
      },
    },
    {
      accessorKey: "unitArrive",
      header: "Arrive",
      enableColumnFilter: false,
      size: 80,
      meta: { align: "right" },
      cell: ({ getValue }) => {
        const v = fmtNum(getValue<number | null>())
        return <span className={v === "—" ? "text-gray-400" : "font-medium tabular-nums"}>{v}</span>
      },
    },
    {
      accessorKey: "unitShip",
      header: "Ship",
      enableColumnFilter: false,
      size: 80,
      meta: { align: "right" },
      cell: ({ getValue }) => {
        const v = fmtNum(getValue<number | null>())
        return <span className={v === "—" ? "text-gray-400" : "font-medium tabular-nums"}>{v}</span>
      },
    },
    {
      accessorKey: "unitHold",
      header: "Hold",
      enableColumnFilter: false,
      size: 80,
      meta: { align: "right" },
      cell: ({ getValue }) => {
        const v = fmtNum(getValue<number | null>())
        return <span className={v === "—" ? "text-gray-400" : "font-medium tabular-nums"}>{v}</span>
      },
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
  ], [])

  // -- Toolbar extra --
  const toolbarExtra = (
    <button onClick={refresh} title="Reload" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-cream-border rounded-lg hover:bg-cream transition-colors text-gray-600">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
        <path d="M8 16H3v5" />
      </svg>
      Reload
    </button>
  )

  // -- Loading / error states --
  if (fetchState.loading && rows.length === 0) {
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
    <DataGrid
      data={rows}
      columns={columns}
      getRowId={(row) => String(row.rowNumber)}
      searchPlaceholder="Search…"
      toolbarExtra={toolbarExtra}
      initialVisibility={{
        unitArrive: false,
        unitShip: false,
        unitHold: false,
        note: false,
        createdAt: false,
        updatedAt: false,
      }}
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
  )
}
