"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { ShoppingListItem, ShoppingListOrder } from "@/lib/db"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import DataGrid, { type ColumnDef } from "@/components/DataGrid"

const INPUT_CLASS =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

// Greedy FIFO fill — mirrors the server-side logic for live preview
function computeFill(orders: ShoppingListOrder[], quantityBought: number) {
  let remaining = quantityBought
  const filled: ShoppingListOrder[] = []
  const unfilled: ShoppingListOrder[] = []
  for (const o of orders) {
    if (remaining >= o.unit) {
      filled.push(o)
      remaining -= o.unit
    } else {
      unfilled.push(o)
    }
  }
  return { filled, unfilled, excessUnits: remaining }
}

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

  function handleBoughtSuccess(item: ShoppingListItem, filledOrderIds: number[]) {
    const remaining = item.orders.filter((o) => !filledOrderIds.includes(o.id))
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
      cell: ({ row }) => {
        const { productName, customerCount, customers } = row.original
        return (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-foreground">{productName}</span>
            <span
              className="text-xs text-gray-400 cursor-help"
              title={customers.join(", ")}
            >
              {customerCount} {customerCount === 1 ? "customer" : "customers"}
            </span>
          </div>
        )
      },
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
      id: "actions",
      header: "",
      enableSorting: false,
      enableHiding: false,
      size: 100,
      cell: ({ row }) => (
        <button
          onClick={() => setBuyingItem(row.original)}
          title="Mark as bought"
          className="text-gray-400 hover:text-green-600 transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
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
      />

      {buyingItem && (
        <BuyModal
          item={buyingItem}
          onClose={() => setBuyingItem(null)}
          onSuccess={(filledOrderIds) => {
            handleBoughtSuccess(buyingItem, filledOrderIds)
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
  onSuccess: (filledOrderIds: number[]) => void
}) {
  const [qty, setQty] = useState(String(item.totalUnits))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const quantityBought = Math.max(0, Number(qty) || 0)
  const preview = computeFill(item.orders, quantityBought)

  async function handleSubmit() {
    if (quantityBought < 1) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch("/api/sheets/shopping-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: item.event,
          productId: item.productId,
          productName: item.productName,
          quantityBought,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to mark as bought")
      onSuccess(data.filledOrderIds ?? [])
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
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-sm flex flex-col gap-5 p-6"
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

        {/* Qty input */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-500">
            Units bought <span className="text-gray-400">(needed: {item.totalUnits})</span>
          </label>
          <input
            type="number"
            min="1"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); if (e.key === "Escape") onClose() }}
            autoFocus
            className="border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
          />
        </div>

        {/* Live preview */}
        {quantityBought > 0 && (
          <div className="flex flex-col gap-2 text-xs">
            {preview.filled.length > 0 && (
              <div>
                <div className="font-medium text-gray-500 mb-1">Will fill ({preview.filled.reduce((s, o) => s + o.unit, 0)} units):</div>
                <div className="flex flex-col gap-0.5">
                  {preview.filled.map((o) => (
                    <div key={o.id} className="flex items-center justify-between px-2 py-1 rounded-md bg-green-50">
                      <span className="text-green-800 truncate">{o.customer}</span>
                      <span className="text-green-700 font-medium ml-2 shrink-0">{o.unit}×</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {preview.unfilled.length > 0 && (
              <div>
                <div className="font-medium text-gray-500 mb-1">Stays in list ({preview.unfilled.reduce((s, o) => s + o.unit, 0)} units):</div>
                <div className="flex flex-col gap-0.5">
                  {preview.unfilled.map((o) => (
                    <div key={o.id} className="flex items-center justify-between px-2 py-1 rounded-md bg-gray-50">
                      <span className="text-gray-500 truncate">{o.customer}</span>
                      <span className="text-gray-400 font-medium ml-2 shrink-0">{o.unit}×</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {preview.excessUnits > 0 && (
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-amber-50 border border-amber-200">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-600 shrink-0">
                  <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                </svg>
                <span className="text-amber-700 font-medium">{preview.excessUnits} excess units → will be added to Excess Purchase</span>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2">
          {saveError && <p className="text-xs text-red-500 mr-auto">{saveError}</p>}
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
            disabled={saving || quantityBought < 1}
            className="px-4 py-1.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : "Mark as Bought"}
          </button>
        </div>
      </div>
    </div>
  )
}
