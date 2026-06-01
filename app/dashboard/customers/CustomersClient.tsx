"use client"

import TableSkeleton from "@/components/TableSkeleton"
import { useEffect, useMemo, useRef, useState } from "react"
import type { CustomerRow, WarehouseRow } from "@/lib/db"
import DataGrid, { type ColumnDef, numericFilter, textContainsFilter } from "@/components/DataGrid"
import { fmt, displayIg } from "@/lib/format"

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
  const [data, setData] = useState<CustomerRow[] | null>(null)
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [creating, setCreating] = useState(false)
  const [editRow, setEditRow] = useState<CustomerRow | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [custRes, whRes] = await Promise.all([
        fetch("/api/sheets/customers"),
        fetch("/api/sheets/warehouses"),
      ])
      const custJson = await custRes.json()
      if (!custRes.ok) throw new Error(custJson.error ?? "Failed to load")
      const whJson = await whRes.json()
      if (!whRes.ok) throw new Error(whJson.error ?? "Failed to load warehouses")
      setData(custJson.rows as CustomerRow[])
      setWarehouses(whJson.rows as WarehouseRow[])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleDelete(row: CustomerRow) {
    if (!confirm(`Delete "${displayIg(row.instagramId)}"? This cannot be undone.`)) return
    try {
      const res = await fetch(`/api/sheets/customers/${row.id}`, { method: "DELETE" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      setData((prev) => prev?.filter((r) => r.id !== row.id) ?? null)
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  const columns = useMemo<ColumnDef<CustomerRow, unknown>[]>(() => [
    {
      accessorKey: "instagramId",
      header: "Instagram ID",
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
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const v = getValue<string>()
        return <span className={v ? "text-foreground" : "text-gray-400"}>{v || "—"}</span>
      },
    },
    {
      accessorKey: "whatsapp",
      header: "WhatsApp",
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const v = getValue<string>()
        return <span className={v ? "text-gray-600 tabular-nums" : "text-gray-400"}>{v || "—"}</span>
      },
    },
    {
      accessorKey: "ekspedisi",
      header: "Ekspedisi",
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const v = getValue<string>()
        return <span className={v ? "text-gray-600" : "text-gray-400"}>{v || "—"}</span>
      },
    },
    // One ongkir column per warehouse (origin). Header shows the warehouse code.
    ...warehouses.map((wh): ColumnDef<CustomerRow, unknown> => ({
      id: `ongkir_${wh.id}`,
      accessorFn: (row) => row.ongkir?.[wh.id] ?? 0,
      header: `Ongkir ${wh.code}`,
      filterFn: "numeric",
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

  const toolbarExtra = (
    <>
      <button
        type="button"
        onClick={load}
        disabled={loading}
        className="text-xs text-gray-500 hover:text-brand disabled:opacity-50 transition-colors px-3 py-1.5 rounded-lg border border-cream-border hover:border-brand"
      >
        {loading ? "…" : "Refresh"}
      </button>
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
      >
        + Add Customer
      </button>
    </>
  )

  return (
    <div className="flex flex-col gap-6">
      {loading && <TableSkeleton />}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {!loading && !error && data && (
        <DataGrid
          data={data}
          columns={columns}
          pageSize={25}
          searchPlaceholder="Search customers…"
          toolbarExtra={toolbarExtra}
          getRowId={(row) => String(row.id)}
          initialVisibility={{ updatedAt: false }}
          initialSorting={[{ id: "instagramId", desc: false }]}
        />
      )}

      {creating && (
        <CustomerModal
          mode="create"
          warehouses={warehouses}
          initial={EMPTY_DRAFT}
          onSaved={(row) => {
            setData((prev) => prev ? [...prev, row].sort((a, b) => a.instagramId.localeCompare(b.instagramId)) : [row])
            setCreating(false)
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {editRow && (
        <CustomerModal
          mode="edit"
          rowId={editRow.id}
          warehouses={warehouses}
          initial={rowToDraft(editRow)}
          onSaved={(row) => {
            setData((prev) => prev?.map((r) => r.id === row.id ? row : r) ?? null)
            setEditRow(null)
          }}
          onCancel={() => setEditRow(null)}
        />
      )}
    </div>
  )
}

// ─── Add / Edit modal ──────────────────────────────────────────────────────

function CustomerModal({
  mode,
  rowId,
  warehouses,
  initial,
  onSaved,
  onCancel,
}: {
  mode: "create" | "edit"
  rowId?: number
  warehouses: WarehouseRow[]
  initial: DraftCustomer
  onSaved: (row: CustomerRow) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<DraftCustomer>(initial)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { firstInputRef.current?.focus() }, [])

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

  async function handleSave() {
    if (!draft.instagramId.trim()) {
      setSaveError("Instagram ID is required")
      return
    }
    setSaving(true)
    setSaveError(null)

    // Build the per-warehouse ongkir map (numbers) from the form's string inputs.
    const ongkir: Record<number, number> = {}
    for (const wh of warehouses) {
      ongkir[wh.id] = Number(draft.ongkir[wh.id]) || 0
    }

    const payload = {
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

    try {
      const url = mode === "create"
        ? "/api/sheets/customers"
        : `/api/sheets/customers/${rowId}`
      const res = await fetch(url, {
        method: mode === "create" ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")

      const id = mode === "create" ? (json.id as number) : rowId!
      const now = new Date().toISOString()
      onSaved({
        id,
        ...payload,
        createdAt: now,
        updatedAt: now,
      })
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
          <span className="text-sm font-semibold text-foreground">
            {mode === "create" ? "Add Customer" : "Edit Customer"}
          </span>
          {mode === "edit" && rowId != null && (
            <span className="text-xs text-gray-400">ID: {rowId}</span>
          )}
        </div>

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
            <span className="text-xs font-medium text-gray-500">Ongkos Kirim per Gudang (IDR)</span>
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
            {saving ? "Saving…" : mode === "create" ? "Add" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}

// Silence unused-import warning for filter symbols expected by DataGrid types
void numericFilter
void textContainsFilter
