"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { ShoppingListItem, ShoppingListOrder } from "@/lib/db"
import { useSheetOptions } from "@/hooks/useSheetOptions"

const INPUT_CLASS =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

// Greedy FIFO fill — mirrors the server-side logic for live preview
function computeFill(orders: ShoppingListOrder[], quantityBought: number) {
  let remaining = quantityBought
  const filled: ShoppingListOrder[] = []
  const unfilled: ShoppingListOrder[] = []
  const totalOrdered = orders.reduce((s, o) => s + o.unit, 0)
  for (const o of orders) {
    if (remaining >= o.unit) {
      filled.push(o)
      remaining -= o.unit
    } else {
      unfilled.push(o)
    }
  }
  // Excess only when bought > total needed; leftover from skipped orders is not excess
  return { filled, unfilled, excessUnits: Math.max(0, quantityBought - totalOrdered) }
}

// ─── Grouping helpers ───────────────────────────────────────────────────────

function groupItems(items: ShoppingListItem[]) {
  const map = new Map<string, Map<string, ShoppingListItem[]>>()
  for (const item of items) {
    if (!map.has(item.event)) map.set(item.event, new Map())
    const storeMap = map.get(item.event)!
    const key = item.store || "—"
    if (!storeMap.has(key)) storeMap.set(key, [])
    storeMap.get(key)!.push(item)
  }
  return map
}

type RowDescriptor =
  | { type: "event-collapsed"; event: string; totalItems: number }
  | { type: "store-collapsed"; event: string; store: string; totalItems: number; showEvent: boolean; eventRowSpan?: number }
  | { type: "item"; item: ShoppingListItem; event: string; store: string; showEvent: boolean; showStore: boolean; eventRowSpan?: number; storeRowSpan?: number }

function buildRows(
  grouped: Map<string, Map<string, ShoppingListItem[]>>,
  collapsedEvents: Set<string>,
  collapsedStores: Set<string>,
): RowDescriptor[] {
  const rows: RowDescriptor[] = []

  for (const [event, storeMap] of grouped) {
    if (collapsedEvents.has(event)) {
      const totalItems = [...storeMap.values()].reduce((s, arr) => s + arr.length, 0)
      rows.push({ type: "event-collapsed", event, totalItems })
      continue
    }

    // Event rowspan = sum of visible rows per store
    let eventRowSpan = 0
    for (const [store, storeItems] of storeMap) {
      eventRowSpan += collapsedStores.has(`${event}|${store}`) ? 1 : storeItems.length
    }

    let firstStoreOfEvent = true
    for (const [store, storeItems] of storeMap) {
      const storeKey = `${event}|${store}`

      if (collapsedStores.has(storeKey)) {
        rows.push({
          type: "store-collapsed",
          event,
          store,
          totalItems: storeItems.length,
          showEvent: firstStoreOfEvent,
          eventRowSpan: firstStoreOfEvent ? eventRowSpan : undefined,
        })
        firstStoreOfEvent = false
        continue
      }

      storeItems.forEach((item, idx) => {
        const showEvent = firstStoreOfEvent && idx === 0
        rows.push({
          type: "item",
          item,
          event,
          store,
          showEvent,
          showStore: idx === 0,
          eventRowSpan: showEvent ? eventRowSpan : undefined,
          storeRowSpan: idx === 0 ? storeItems.length : undefined,
        })
        if (idx === 0) firstStoreOfEvent = false
      })
    }
  }

  return rows
}

function CollapseBtn({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center justify-center w-4 h-4 rounded border border-gray-300 bg-white text-gray-500 hover:text-brand hover:border-brand transition-colors text-xs font-bold shrink-0"
    >
      {collapsed ? "+" : "−"}
    </button>
  )
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function ShoppingListClient() {
  const options = useSheetOptions()
  const [items, setItems] = useState<ShoppingListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [selectedEvent, setSelectedEvent] = useState("")
  const [search, setSearch] = useState("")
  const [buyingItem, setBuyingItem] = useState<ShoppingListItem | null>(null)
  const [collapsedEvents, setCollapsedEvents] = useState<Set<string>>(new Set())
  const [collapsedStores, setCollapsedStores] = useState<Set<string>>(new Set())

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

  function toggleEvent(event: string) {
    setCollapsedEvents((prev) => {
      const next = new Set(prev)
      next.has(event) ? next.delete(event) : next.add(event)
      return next
    })
  }

  function toggleStore(event: string, store: string) {
    const key = `${event}|${store}`
    setCollapsedStores((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const filteredItems = useMemo(() => {
    if (!search.trim()) return items
    const q = search.toLowerCase()
    return items.filter(
      (i) =>
        i.productName.toLowerCase().includes(q) ||
        i.event.toLowerCase().includes(q) ||
        (i.store ?? "").toLowerCase().includes(q),
    )
  }, [items, search])

  const grouped = useMemo(() => groupItems(filteredItems), [filteredItems])
  const rows = useMemo(
    () => buildRows(grouped, collapsedEvents, collapsedStores),
    [grouped, collapsedEvents, collapsedStores],
  )

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
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search shopping list…"
          className={`${INPUT_CLASS} flex-1 min-w-[180px]`}
        />
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
      </div>

      {/* Grouped table */}
      <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-cream-border bg-gray-50/80">
              <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-44">Event</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-36">Store</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500">Product</th>
              <th className="text-right px-4 py-2.5 font-medium text-gray-500 w-14">Qty</th>
              <th className="px-4 py-2.5 w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-gray-400 py-12 text-sm">
                  No items
                </td>
              </tr>
            )}
            {rows.map((row) => {
              if (row.type === "event-collapsed") {
                return (
                  <tr key={`${row.event}~collapsed`} className="border-b border-cream-border">
                    <td colSpan={5} className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <CollapseBtn collapsed onClick={() => toggleEvent(row.event)} />
                        <span className="font-medium text-foreground">{row.event}</span>
                        <span className="text-xs text-gray-400">{row.totalItems} items</span>
                      </div>
                    </td>
                  </tr>
                )
              }

              if (row.type === "store-collapsed") {
                return (
                  <tr key={`${row.event}|${row.store}~collapsed`} className="border-b border-cream-border">
                    {row.showEvent && (
                      <td rowSpan={row.eventRowSpan} className="px-4 py-2.5 align-top border-r border-cream-border">
                        <div className="flex items-center gap-2 pt-0.5">
                          <CollapseBtn collapsed={false} onClick={() => toggleEvent(row.event)} />
                          <span className="font-medium text-foreground">{row.event}</span>
                        </div>
                      </td>
                    )}
                    <td colSpan={4} className="px-4 py-2.5 bg-gray-50/40">
                      <div className="flex items-center gap-2">
                        <CollapseBtn collapsed onClick={() => toggleStore(row.event, row.store)} />
                        <span className="text-gray-600">{row.store}</span>
                        <span className="text-xs text-gray-400">{row.totalItems} items</span>
                      </div>
                    </td>
                  </tr>
                )
              }

              // type === "item"
              return (
                <tr
                  key={`${row.event}|${row.store}|${row.item.productId}`}
                  className="border-b border-cream-border hover:bg-gray-50/50 transition-colors"
                >
                  {row.showEvent && (
                    <td rowSpan={row.eventRowSpan} className="px-4 py-2.5 align-top border-r border-cream-border">
                      <div className="flex items-center gap-2 pt-0.5">
                        <CollapseBtn collapsed={false} onClick={() => toggleEvent(row.event)} />
                        <span className="font-medium text-foreground">{row.event}</span>
                      </div>
                    </td>
                  )}
                  {row.showStore && (
                    <td rowSpan={row.storeRowSpan} className="px-4 py-2.5 align-top border-r border-cream-border">
                      <div className="flex items-center gap-2 pt-0.5">
                        <CollapseBtn collapsed={false} onClick={() => toggleStore(row.event, row.store)} />
                        <span className="text-gray-600">{row.store}</span>
                      </div>
                    </td>
                  )}
                  <td className="px-4 py-2.5">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-foreground">{row.item.productName}</span>
                      <span
                        className="text-xs text-gray-400 cursor-help"
                        title={row.item.customers.join(", ")}
                      >
                        {row.item.customerCount} {row.item.customerCount === 1 ? "customer" : "customers"}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="tabular-nums font-bold text-foreground">{row.item.totalUnits}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => setBuyingItem(row.item)}
                      title="Mark as bought"
                      className="text-gray-400 hover:text-green-600 transition-colors"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

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
  const [receipt, setReceipt] = useState("")
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
          receipt: receipt.trim(),
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

        {/* Qty + Receipt inputs */}
        <div className="flex flex-col gap-3">
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
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-500">
              Receipt <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={receipt}
              onChange={(e) => setReceipt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); if (e.key === "Escape") onClose() }}
              placeholder="e.g. INV-001"
              className="border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
            />
          </div>
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
