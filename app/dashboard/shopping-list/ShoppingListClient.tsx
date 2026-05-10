"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { ShoppingListItem, ShoppingListOrder } from "@/lib/db"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import DataGrid, { type ColumnDef } from "@/components/DataGrid"

const INPUT_CLASS =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

export default function ShoppingListClient() {
  const options = useSheetOptions()
  const [items, setItems] = useState<ShoppingListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [selectedEvent, setSelectedEvent] = useState("")
  const [buyingItem, setBuyingItem] = useState<ShoppingListItem | null>(null)

  const fetchItems = useCallback((event?: string) => {
    setLoading(true)
    const url = event
      ? `/api/sheets/shopping-list?event=${encodeURIComponent(event)}`
      : "/api/sheets/shopping-list"
    fetch(url, { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { items?: ShoppingListItem[]; error?: string }) => {
        if (data.error) throw new Error(data.error)
        setItems(data.items ?? [])
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetchItems(selectedEvent || undefined)
  }, [fetchItems, selectedEvent])

  function handleBoughtSuccess(item: ShoppingListItem, boughtOrderIds: number[]) {
    const remaining = item.orders.filter((o) => !boughtOrderIds.includes(o.id))
    if (remaining.length === 0) {
      setItems((prev) =>
        prev.filter((i) => !(i.event === item.event && i.productId === item.productId)),
      )
    } else {
      setItems((prev) =>
        prev.map((i) => {
          if (i.event !== item.event || i.productId !== item.productId) return i
          const uniqueCustomers = [...new Set(remaining.map((o) => o.customer))].sort()
          return {
            ...i,
            orders: remaining,
            orderIds: remaining.map((o) => o.id),
            totalUnits: remaining.reduce((sum, o) => sum + o.unit, 0),
            customerCount: uniqueCustomers.length,
            customers: uniqueCustomers,
          }
        }),
      )
    }
  }

  const columns = useMemo<ColumnDef<ShoppingListItem, unknown>[]>(() => [
    {
      accessorKey: "event",
      header: "Event",
      filterFn: "textContains" as unknown as undefined,
    },
    {
      accessorKey: "productName",
      header: "Product",
      enableHiding: false,
      filterFn: "textContains" as unknown as undefined,
      cell: ({ row }) => (
        <span className="font-medium text-foreground">{row.original.productName}</span>
      ),
    },
    {
      accessorKey: "store",
      header: "Store",
      filterFn: "textContains" as unknown as undefined,
      cell: ({ row }) => (
        <span className="text-gray-500">{row.original.store || "—"}</span>
      ),
    },
    {
      accessorKey: "totalUnits",
      header: "Qty",
      meta: { align: "right" },
      cell: ({ row }) => (
        <span className="tabular-nums font-bold text-foreground">{row.original.totalUnits}</span>
      ),
    },
    {
      accessorKey: "customerCount",
      header: "Customers",
      meta: { align: "right" },
      cell: ({ row }) => (
        <span
          className="tabular-nums text-gray-500 cursor-help"
          title={row.original.customers.join(", ")}
        >
          {row.original.customerCount}
        </span>
      ),
    },
    {
      accessorKey: "customers",
      header: "Customer List",
      enableSorting: false,
      cell: ({ row }) => (
        <span
          className="text-xs text-gray-400 truncate block max-w-[200px]"
          title={row.original.customers.join(", ")}
        >
          {row.original.customers.join(", ")}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableHiding: false,
      size: 100,
      cell: ({ row }) => (
        <button
          onClick={() => setBuyingItem(row.original)}
          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-green-50 text-green-700 hover:bg-green-100 transition-colors whitespace-nowrap"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          Bought
        </button>
      ),
    },
  ], [])

  const toolbarExtra = useMemo(() => (
    <>
      <select
        value={selectedEvent}
        onChange={(e) => setSelectedEvent(e.target.value)}
        className={INPUT_CLASS}
        style={{ width: "12rem" }}
      >
        <option value="">All Events</option>
        {(options?.events ?? []).map((ev) => (
          <option key={ev} value={ev}>{ev}</option>
        ))}
      </select>
      <button
        onClick={() => fetchItems(selectedEvent || undefined)}
        title="Refresh"
        className="p-1.5 text-gray-400 hover:text-brand transition-colors rounded"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-6.22-8.56" /><polyline points="21 3 21 9 15 9" />
        </svg>
      </button>
    </>
  ), [selectedEvent, options?.events, fetchItems])

  if (loading) {
    return (
      <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-gray-400">
        Loading...
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
    <>
      <DataGrid
        data={items}
        columns={columns}
        getRowId={(row) => `${row.event}-${row.productId}`}
        searchPlaceholder="Search shopping list..."
        toolbarExtra={toolbarExtra}
        initialVisibility={{ customers: false }}
      />

      {buyingItem && (
        <BuyModal
          item={buyingItem}
          onClose={() => setBuyingItem(null)}
          onSuccess={(boughtIds) => {
            handleBoughtSuccess(buyingItem, boughtIds)
            setBuyingItem(null)
          }}
        />
      )}
    </>
  )
}

// ─── Buy Modal ─────────────────────────────────────────────────────────────

function BuyModal({
  item,
  onClose,
  onSuccess,
}: {
  item: ShoppingListItem
  onClose: () => void
  onSuccess: (boughtOrderIds: number[]) => void
}) {
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(item.orders.map((o) => o.id)),
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const allChecked = selected.size === item.orders.length
  const noneChecked = selected.size === 0
  const selectedUnits = item.orders
    .filter((o) => selected.has(o.id))
    .reduce((sum, o) => sum + o.unit, 0)

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(item.orders.map((o) => o.id)))
  }

  async function handleSubmit() {
    if (noneChecked) return
    setSaving(true)
    setSaveError(null)
    try {
      const orderIds = [...selected]
      const res = await fetch("/api/sheets/shopping-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to mark as bought")
      }
      onSuccess(orderIds)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to mark as bought")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-md flex flex-col gap-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">{item.productName}</div>
            <div className="text-xs text-gray-400 mt-0.5">
              {item.event}{item.store ? ` · ${item.store}` : ""}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-brand transition-colors shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Order list */}
        <div className="flex flex-col gap-1">
          {/* Select all row */}
          <label className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-cream cursor-pointer border-b border-cream-border pb-2 mb-1">
            <input
              type="checkbox"
              checked={allChecked}
              ref={(el) => { if (el) el.indeterminate = !allChecked && !noneChecked }}
              onChange={toggleAll}
              className="w-4 h-4 rounded accent-brand"
            />
            <span className="text-xs font-medium text-gray-500">Select all</span>
          </label>

          {/* Per-order rows */}
          <div className="flex flex-col gap-0.5 max-h-64 overflow-y-auto">
            {item.orders.map((order) => (
              <OrderRow
                key={order.id}
                order={order}
                checked={selected.has(order.id)}
                onToggle={() => toggle(order.id)}
              />
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 pt-1 border-t border-cream-border">
          <div className="text-xs text-gray-500">
            <span className="font-semibold text-foreground">{selectedUnits}</span>
            {" "}of {item.totalUnits} units selected
          </div>
          <div className="flex items-center gap-2">
            {saveError && <p className="text-xs text-red-500">{saveError}</p>}
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={saving || noneChecked}
              className="px-4 py-1.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving…" : "Mark as Bought"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function OrderRow({
  order,
  checked,
  onToggle,
}: {
  order: ShoppingListOrder
  checked: boolean
  onToggle: () => void
}) {
  return (
    <label className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-cream cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="w-4 h-4 rounded accent-brand shrink-0"
      />
      <span className="flex-1 text-sm text-foreground truncate">{order.customer}</span>
      <span className="tabular-nums text-sm font-medium text-gray-600 shrink-0">{order.unit}×</span>
    </label>
  )
}
