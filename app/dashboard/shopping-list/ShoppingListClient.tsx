"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { ShoppingListItem } from "@/lib/db"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import DataGrid, {
  textContainsFilter,
  type ColumnDef,
} from "@/components/DataGrid"

const INPUT_CLASS =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

export default function ShoppingListClient() {
  const options = useSheetOptions()
  const [items, setItems] = useState<ShoppingListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [selectedEvent, setSelectedEvent] = useState("")
  const [buyingIds, setBuyingIds] = useState<Set<string>>(new Set())

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

  async function handleMarkAsBought(item: ShoppingListItem) {
    const key = `${item.event}-${item.productId}`
    if (!confirm(`Mark "${item.productName}" (${item.totalUnits} units) as bought?`)) return
    setBuyingIds((prev) => new Set(prev).add(key))
    try {
      const res = await fetch("/api/sheets/shopping-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: item.orderIds }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to mark as bought")
      }
      // Remove item from the list on success
      setItems((prev) =>
        prev.filter((i) => !(i.event === item.event && i.productId === item.productId)),
      )
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to mark as bought")
    } finally {
      setBuyingIds((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const columns = useMemo<ColumnDef<ShoppingListItem, unknown>[]>(() => [
    {
      accessorKey: "event",
      header: "Event",
      enableHiding: true,
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
      enableHiding: true,
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
      enableHiding: true,
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-xs text-gray-400 truncate block max-w-[200px]" title={row.original.customers.join(", ")}>
          {row.original.customers.join(", ")}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableHiding: false,
      size: 120,
      cell: ({ row }) => {
        const item = row.original
        const key = `${item.event}-${item.productId}`
        const isBuying = buyingIds.has(key)
        return (
          <button
            onClick={() => handleMarkAsBought(item)}
            disabled={isBuying}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-green-50 text-green-700 hover:bg-green-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {isBuying ? (
              "Marking..."
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                Bought
              </>
            )}
          </button>
        )
      },
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [buyingIds])

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
    <DataGrid
      data={items}
      columns={columns}
      getRowId={(row) => `${row.event}-${row.productId}`}
      searchPlaceholder="Search shopping list..."
      toolbarExtra={toolbarExtra}
      initialVisibility={{ customers: false }}
    />
  )
}
