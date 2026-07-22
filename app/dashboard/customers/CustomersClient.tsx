"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CustomerRow, WarehouseRow } from "@/lib/db"
import DataGrid, {
  numericFilter,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type PaginationState,
} from "@/components/DataGrid"
import { usePaginatedFetch, type PageData } from "@/hooks/usePaginatedFetch"
import { fmt, displayIg } from "@/lib/format"
import { CustomerDetailDrawer } from "./CustomerDetailDrawer"

const PAGE_SIZE = 25

// Build a wa.me link from a stored WhatsApp number. Indonesian numbers are
// normalized to international (0… → 62…, 8… → 62…). Returns null when empty.
function waHref(phone: string | null | undefined): string | null {
  let num = (phone ?? "").replace(/[^\d]/g, "")
  if (!num) return null
  if (num.startsWith("0")) num = "62" + num.slice(1)
  else if (num.startsWith("8")) num = "62" + num
  return `https://wa.me/${num}`
}

const modalInputCls = "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-50"

type DraftCustomer = {
  instagramId: string
  name: string
  whatsapp: string
  dataDiri: string
  ekspedisi: string
  // Per-warehouse ongkir, keyed by warehouse id (string for the number input).
  ongkir: Record<number, string>
  bankName: string
  bankAccountNumber: string
  bankAccountHolder: string
}

const EMPTY_DRAFT: DraftCustomer = {
  instagramId: "",
  name: "",
  whatsapp: "",
  dataDiri: "",
  ekspedisi: "",
  ongkir: {},
  bankName: "",
  bankAccountNumber: "",
  bankAccountHolder: "",
}

function rowToDraft(row: CustomerRow): DraftCustomer {
  const ongkir: Record<number, string> = {}
  for (const [wid, val] of Object.entries(row.ongkir ?? {})) {
    ongkir[Number(wid)] = val ? String(val) : ""
  }
  return {
    instagramId: row.instagramId,
    name: row.name,
    whatsapp: row.whatsapp,
    dataDiri: row.dataDiri,
    ekspedisi: row.ekspedisi,
    ongkir,
    bankName: row.bankName,
    bankAccountNumber: row.bankAccountNumber,
    bankAccountHolder: row.bankAccountHolder,
  }
}

export default function CustomersClient() {
  // Current page of rows + total — both come from the server now.
  const [data, setData] = useState<CustomerRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  // Warehouses drive the dynamic ongkir columns and the modal's per-warehouse
  // inputs; they can't be derived from one page of customers, so load once.
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([])
  const [metaError, setMetaError] = useState<string | null>(null)

  const [creating, setCreating] = useState(false)
  const [editRow, setEditRow] = useState<CustomerRow | null>(null)
  const [detailCustomer, setDetailCustomer] = useState<string | null>(null)

  // Server-side table state.
  const [sorting, setSorting] = useState<SortingState>([{ id: "instagramId", desc: false }])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState("")
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE })

  const loadMeta = useCallback(async () => {
    try {
      const res = await fetch("/api/sheets/warehouses")
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to load warehouses")
      setWarehouses(json.rows as WarehouseRow[])
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : "Failed to load")
    }
  }, [])
  useEffect(() => { loadMeta() }, [loadMeta])

  // Text column filters → server query params. The date column isn't
  // server-filterable. Ongkir columns are numeric ({op, value}, not a plain
  // string) and the server can only join one warehouse's ongkir per query, so
  // only the first active ongkir filter is sent — later ones are ignored.
  const fetchFilters = useMemo<Record<string, string>>(() => {
    const f: Record<string, string> = {}
    for (const cf of columnFilters) {
      const ongkirMatch = cf.id.match(/^ongkir_(\d+)$/)
      if (ongkirMatch) {
        if (f.ongkirWarehouseId) continue
        const { op, value } = (cf.value ?? {}) as { op?: string; value?: number }
        if (!op || value == null || Number.isNaN(value)) continue
        f.ongkirWarehouseId = ongkirMatch[1]
        f.ongkirOp = op
        f.ongkirValue = String(value)
        continue
      }
      const v = String(cf.value ?? "").trim()
      if (!v) continue
      if (cf.id === "instagramId") f.instagramId = v
      else if (cf.id === "name") f.name = v
      else if (cf.id === "whatsapp") f.whatsapp = v
      else if (cf.id === "ekspedisi") f.ekspedisi = v
      else if (cf.id === "dataDiri") f.dataDiri = v
      else if (cf.id === "bankName") f.bankName = v
    }
    return f
  }, [columnFilters])

  const fetchSort = useMemo(() => {
    if (sorting.length === 0) return null
    return { key: sorting[0].id, direction: sorting[0].desc ? ("desc" as const) : ("asc" as const) }
  }, [sorting])

  const onData = useCallback((d: PageData) => {
    setData(d.rows as CustomerRow[])
    setTotalCount(d.totalCount)
  }, [])

  const { fetchState, refresh } = usePaginatedFetch({
    endpoint: "/api/sheets/customers",
    pageSize: PAGE_SIZE,
    page: pagination.pageIndex + 1,
    search: globalFilter,
    filters: fetchFilters,
    sort: fetchSort,
    onData,
  })

  // Stable ref so row-action callbacks captured in column defs always call the
  // latest refresh.
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // Reset to page 1 whenever the query shape (sort / filter / search) changes.
  const handleSortingChange = useCallback((u: SortingState | ((p: SortingState) => SortingState)) => {
    setSorting(u)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleColumnFiltersChange = useCallback((u: ColumnFiltersState | ((p: ColumnFiltersState) => ColumnFiltersState)) => {
    setColumnFilters(u)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleGlobalFilterChange = useCallback((u: string | ((p: string) => string)) => {
    setGlobalFilter(u)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])

  async function handleDelete(row: CustomerRow) {
    if (!confirm(`Delete "${displayIg(row.instagramId)}"? This cannot be undone.`)) return
    try {
      const res = await fetch(`/api/sheets/customers/${row.id}`, { method: "DELETE" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      refreshRef.current()
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  const columns = useMemo<ColumnDef<CustomerRow, unknown>[]>(() => [
    {
      accessorKey: "instagramId",
      header: "Instagram ID",
      size: 160,
      filterFn: "textContains",
      cell: ({ row }) => {
        const hasAddress = Boolean(row.original.dataDiri && row.original.dataDiri.trim())
        return (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-medium tabular-nums">{displayIg(row.original.instagramId)}</span>
            {!hasAddress && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500 shrink-0" aria-label="No address filled">
                <title>No address filled</title>
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            )}
          </span>
        )
      },
    },
    {
      accessorKey: "name",
      header: "Name",
      size: 160,
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const v = getValue<string>()
        return <span className={v ? "text-foreground" : "text-gray-400"}>{v || "—"}</span>
      },
    },
    {
      accessorKey: "whatsapp",
      header: "WhatsApp",
      size: 140,
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const v = getValue<string>()
        return <span className={v ? "text-gray-600 tabular-nums" : "text-gray-400"}>{v || "—"}</span>
      },
    },
    {
      accessorKey: "ekspedisi",
      header: "Ekspedisi",
      size: 120,
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const v = getValue<string>()
        return <span className={v ? "text-gray-600" : "text-gray-400"}>{v || "—"}</span>
      },
    },
    // One ongkir column per warehouse (origin). Header shows the warehouse code.
    // Server-sortable via a join scoped to that one warehouse (see
    // getCustomersPaginated). Column filter UI is hidden (sort only) — the
    // numeric filterFn/fetchFilters plumbing stays wired server-side in case
    // it's re-enabled later.
    ...warehouses.map((wh): ColumnDef<CustomerRow, unknown> => ({
      id: `ongkir_${wh.id}`,
      accessorFn: (row) => row.ongkir?.[wh.id] ?? 0,
      header: `Ongkir ${wh.code}`,
      size: 120,
      enableColumnFilter: false,
      meta: { align: "right" },
      cell: ({ getValue }) => {
        const v = getValue<number>()
        return v > 0
          ? <span className="tabular-nums">Rp {fmt(v)}</span>
          : <span className="text-gray-400">—</span>
      },
    })),
    {
      accessorKey: "dataDiri",
      header: "Alamat",
      // No explicit size — DataGrid leaves size-150 (tanstack default) columns
      // unset in the header style, so this one column flexes to absorb any
      // leftover table width instead of it landing on the actions column.
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const v = getValue<string>()
        if (!v) return <span className="text-gray-400">—</span>
        return (
          <span className="text-gray-500 text-xs whitespace-pre-line line-clamp-2" title={v}>
            {v}
          </span>
        )
      },
    },
    {
      accessorKey: "bankName",
      header: "Bank",
      size: 180,
      filterFn: "textContains",
      cell: ({ row }) => {
        const { bankName, bankAccountNumber, bankAccountHolder } = row.original
        if (!bankName && !bankAccountNumber && !bankAccountHolder) {
          return <span className="text-gray-400">—</span>
        }
        return (
          <div className="text-xs leading-tight">
            <div className="font-medium text-gray-700">{bankName || "—"}</div>
            {bankAccountNumber && <div className="text-gray-500 tabular-nums">{bankAccountNumber}</div>}
            {bankAccountHolder && <div className="text-gray-400">{bankAccountHolder}</div>}
          </div>
        )
      },
    },
    {
      accessorKey: "updatedAt",
      header: "Updated",
      size: 110,
      enableColumnFilter: false,
      cell: ({ getValue }) => {
        const v = getValue<string | null>()
        return v ? (
          <span className="text-gray-400 text-xs whitespace-nowrap">{new Date(v).toLocaleDateString("id-ID")}</span>
        ) : ""
      },
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableColumnFilter: false,
      enableHiding: false,
      size: 80,
      cell: ({ row }) => (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setEditRow(row.original)}
            title="Edit"
            className="text-gray-400 hover:text-brand transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => handleDelete(row.original)}
            title="Delete"
            className="text-gray-400 hover:text-red-500 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      ),
    },
  ], [warehouses])

  const renderMobileCard = useCallback((row: CustomerRow) => {
    const hasAddress = Boolean(row.dataDiri && row.dataDiri.trim())
    return (
      <div className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-foreground tabular-nums">{displayIg(row.instagramId)}</span>
            {!hasAddress && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500 shrink-0" aria-label="No address filled">
                <title>No address filled</title>
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5 truncate uppercase">{row.whatsapp || "—"}{row.name ? ` · ${row.name}` : ""}</div>
        </div>
        {/* WhatsApp (opens chat with the customer's number) + kebab. The kebab
            (not the row itself) opens the action sheet — tapping the row already
            opens the customer detail drawer via DataGrid's onRowClick. */}
        <div className="shrink-0 flex items-center -space-x-2.5">
          {waHref(row.whatsapp) && (
            <a
              href={waHref(row.whatsapp)!}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              aria-label="Chat on WhatsApp"
              className="inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-green-600 transition-colors"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17.5 14.4c-.3-.15-1.77-.87-2.04-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51-.17-.01-.37-.01-.57-.01-.2 0-.52.07-.8.37-.27.3-1.05 1.02-1.05 2.5s1.07 2.9 1.22 3.1c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.7.62.71.23 1.36.2 1.87.12.57-.08 1.77-.72 2.02-1.42.25-.7.25-1.3.17-1.42-.07-.12-.27-.2-.57-.35zM12.05 21.5h-.01a9.4 9.4 0 0 1-4.8-1.32l-.34-.2-3.57.94.95-3.48-.22-.36a9.42 9.42 0 0 1-1.44-5.02c0-5.2 4.24-9.44 9.45-9.44 2.52 0 4.89.98 6.67 2.77a9.38 9.38 0 0 1 2.76 6.68c0 5.2-4.24 9.44-9.45 9.44zm8.04-17.49A11.36 11.36 0 0 0 12.05.5C5.8.5.72 5.58.72 11.83c0 2 .52 3.95 1.51 5.67L.63 23.5l6.14-1.61a11.33 11.33 0 0 0 5.28 1.34h.01c6.25 0 11.33-5.08 11.33-11.33 0-3.03-1.18-5.87-3.32-8.01z" />
              </svg>
            </a>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setEditRow(row) }}
            aria-label="More actions"
            className="p-1.5 text-gray-400 hover:text-brand transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
            </svg>
          </button>
        </div>
      </div>
    )
  }, [])

  const toolbarExtra = (
    <button
      type="button"
      onClick={() => setCreating(true)}
      className="hidden md:inline-flex px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
    >
      + Add Customer
    </button>
  )

  const errorMsg = fetchState.error || metaError

  return (
    <div className="flex flex-col gap-6">
      {errorMsg && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{errorMsg}</div>
      )}

      <DataGrid
        data={data}
        columns={columns}
        getRowId={(row) => String(row.id)}
        searchPlaceholder="Search customers…"
        fullWidthSearch
        tightToolbar
        boldUppercaseHeader
        toolbarExtraAfterColumns
        hideRowCount
        toolbarExtra={toolbarExtra}
        initialVisibility={{ updatedAt: false, dataDiri: false, bankName: false, whatsapp: false }}
        renderMobileCard={renderMobileCard}
        onRowClick={(row) => setDetailCustomer(row.instagramId)}
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

      {/* Mobile add FAB */}
      <button
        type="button"
        onClick={() => setCreating(true)}
        aria-label="Add customer"
        className="md:hidden fixed right-4 bottom-20 z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90"
      >
        +
      </button>

      {creating && (
        <CreateCustomerModal
          warehouses={warehouses}
          onSaved={() => { setCreating(false); refreshRef.current() }}
          onCancel={() => setCreating(false)}
        />
      )}

      {editRow && (
        <EditCustomerModal
          rowId={editRow.id}
          warehouses={warehouses}
          initial={rowToDraft(editRow)}
          onSaved={() => { setEditRow(null); refreshRef.current() }}
          onCancel={() => setEditRow(null)}
          onDelete={() => { const r = editRow; setEditRow(null); handleDelete(r) }}
        />
      )}

      {detailCustomer && (
        <CustomerDetailDrawer customer={detailCustomer} onClose={() => setDetailCustomer(null)} />
      )}

    </div>
  )
}

// ─── Add / Edit form ──────────────────────────────────────────────────────

// Shared field set for the Add card and the Edit modal below.
function CustomerFields({
  draft, setDraft, warehouses, saving, firstInputRef,
}: {
  draft: DraftCustomer
  setDraft: React.Dispatch<React.SetStateAction<DraftCustomer>>
  warehouses: WarehouseRow[]
  saving: boolean
  firstInputRef?: React.RefObject<HTMLInputElement | null>
}) {
  // Only the plain string fields go through this helper; ongkir is a map and is
  // handled with its own per-warehouse inputs below.
  function field(key: Exclude<keyof DraftCustomer, "ongkir">) {
    return {
      value: draft[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setDraft((d) => ({ ...d, [key]: e.target.value })),
      disabled: saving,
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Instagram ID <span className="text-red-500">*</span></span>
        <input
          ref={firstInputRef}
          {...field("instagramId")}
          placeholder="@username"
          className={modalInputCls}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Name</span>
        <input
          {...field("name")}
          placeholder="Full name"
          className={modalInputCls}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">WhatsApp</span>
        <input
          {...field("whatsapp")}
          placeholder="08xx-xxxx-xxxx"
          className={modalInputCls}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Alamat / Data Diri</span>
        <textarea
          {...field("dataDiri")}
          placeholder="Full name, address, phone…"
          rows={4}
          className={`${modalInputCls} resize-none`}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Ekspedisi</span>
        <input
          {...field("ekspedisi")}
          placeholder="e.g. JNE, J&T"
          className={modalInputCls}
        />
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Ongkos kirim per kg</span>
        {warehouses.length === 0 ? (
          <span className="text-xs text-gray-400">No warehouses configured.</span>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {warehouses.map((wh) => (
              <label key={wh.id} className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-gray-400">{wh.name} ({wh.code})</span>
                <input
                  value={draft.ongkir[wh.id] ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, ongkir: { ...d.ongkir, [wh.id]: e.target.value } }))
                  }
                  disabled={saving}
                  type="number"
                  min="0"
                  placeholder="0"
                  className={modalInputCls}
                />
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="pt-2 border-t border-cream-border" />

      <div className="text-xs font-semibold text-gray-500 -mb-1">Bank Info</div>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Bank Name</span>
        <input
          {...field("bankName")}
          placeholder="e.g. BCA, Mandiri"
          className={modalInputCls}
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-500">Account Number</span>
          <input
            {...field("bankAccountNumber")}
            placeholder="1234567890"
            className={modalInputCls}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-500">Account Holder</span>
          <input
            {...field("bankAccountHolder")}
            placeholder="Name as registered"
            className={modalInputCls}
          />
        </label>
      </div>
    </div>
  )
}

function buildCustomerPayload(draft: DraftCustomer, warehouses: WarehouseRow[]) {
  // Build the per-warehouse ongkir map (numbers) from the form's string inputs.
  const ongkir: Record<number, number> = {}
  for (const wh of warehouses) {
    ongkir[wh.id] = Number(draft.ongkir[wh.id]) || 0
  }
  return {
    instagramId: draft.instagramId.trim(),
    name: draft.name.trim(),
    whatsapp: draft.whatsapp.trim(),
    dataDiri: draft.dataDiri.trim(),
    ekspedisi: draft.ekspedisi.trim(),
    ongkir,
    bankName: draft.bankName.trim(),
    bankAccountNumber: draft.bankAccountNumber.trim(),
    bankAccountHolder: draft.bankAccountHolder.trim(),
  }
}

function CreateCustomerModal({
  warehouses,
  onSaved,
  onCancel,
}: {
  warehouses: WarehouseRow[]
  onSaved: () => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<DraftCustomer>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { firstInputRef.current?.focus() }, [])

  async function handleSave() {
    if (!draft.instagramId.trim()) {
      setSaveError("Instagram ID is required")
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch("/api/sheets/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCustomerPayload(draft, warehouses)),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onSaved()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") onCancel()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onCancel}>
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl p-6 w-full max-w-lg flex flex-col gap-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">Add Customer</span>
        </div>

        <CustomerFields draft={draft} setDraft={setDraft} warehouses={warehouses} saving={saving} firstInputRef={firstInputRef} />

        {saveError && <p className="text-xs text-red-500">{saveError}</p>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  )
}

function EditCustomerModal({
  rowId,
  warehouses,
  initial,
  onSaved,
  onCancel,
  onDelete,
}: {
  rowId: number
  warehouses: WarehouseRow[]
  initial: DraftCustomer
  onSaved: () => void
  onCancel: () => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState<DraftCustomer>(initial)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  async function handleSave() {
    if (!draft.instagramId.trim()) {
      setSaveError("Instagram ID is required")
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(`/api/sheets/customers/${rowId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCustomerPayload(draft, warehouses)),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")

      // The list re-fetches the current page from the server (onSaved → refresh),
      // so we don't reconstruct the row optimistically here.
      onSaved()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") onCancel()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onCancel}>
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl p-6 w-full max-w-lg flex flex-col gap-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">Edit Customer</span>
          <span className="text-xs text-gray-400">ID: {rowId}</span>
        </div>

        <CustomerFields draft={draft} setDraft={setDraft} warehouses={warehouses} saving={saving} />

        {saveError && <p className="text-xs text-red-500">{saveError}</p>}

        <div className="flex items-center gap-2 pt-2">
          <button
            type="button"
            onClick={onDelete}
            disabled={saving}
            aria-label="Delete"
            className="inline-flex items-center justify-center h-[38px] md:h-auto border border-cream-border md:border-transparent rounded-lg md:rounded-none px-3 md:px-0 md:py-2 text-sm text-gray-400 md:text-red-500 hover:border-brand md:hover:border-transparent md:hover:underline disabled:opacity-50 transition-colors"
          >
            <svg className="md:hidden" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" />
            </svg>
            <span className="hidden md:inline">Delete</span>
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="ml-auto px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}
