"use client"

import { displayIg } from "@/lib/format"
import TableSkeleton from "@/components/TableSkeleton"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ArrivalListItem, ArrivalListOrder } from "@/lib/db"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { allocateFifo } from "@/lib/fifo-fill"
import { fetchJson } from "@/lib/api-fetch"
import ArriveBulkModal from "./ArriveBulkModal"
import EventSelect from "@/components/EventSelect"
import SearchableSelect from "@/components/SearchableSelect"
import { generateCargoDocument } from "@/lib/cargo-document-pdf"

const INPUT_CLASS =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

function computeFill(orders: ArrivalListOrder[], quantityArrived: number) {
  const { allocations, unallocated, excess } = allocateFifo(orders, (o) => o.pending, quantityArrived)
  return {
    filled: allocations.map(({ item, allocated }) => ({ order: item, allocated })),
    unfilled: unallocated,
    unassignedUnits: excess,
  }
}

// ─── Grouping helpers ───────────────────────────────────────────────────────

function groupItems(items: ArrivalListItem[]) {
  const map = new Map<string, Map<string, ArrivalListItem[]>>()
  for (const item of items) {
    if (!map.has(item.event)) map.set(item.event, new Map())
    const storeMap = map.get(item.event)!
    const key = item.store || "—"
    if (!storeMap.has(key)) storeMap.set(key, [])
    storeMap.get(key)!.push(item)
  }
  return map
}

/** Stable selection key: event + productId (productId repeats across events). */
function selKey(item: Pick<ArrivalListItem, "event" | "productId">): string {
  return `${item.event}|${item.productId}`
}

type RowDescriptor =
  | { type: "event-collapsed"; event: string; totalItems: number }
  | { type: "store-collapsed"; event: string; store: string; totalItems: number; showEvent: boolean; eventRowSpan?: number }
  | { type: "item"; item: ArrivalListItem; event: string; store: string; showEvent: boolean; showStore: boolean; eventRowSpan?: number; storeRowSpan?: number }

function buildRows(
  grouped: Map<string, Map<string, ArrivalListItem[]>>,
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

function CustomerBadge({ orders }: { orders: { customer: string; qty: number }[] }) {
  const [open, setOpen] = useState(false)
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  const entries = useMemo(() => {
    const map = new Map<string, number>()
    for (const o of orders) map.set(o.customer, (map.get(o.customer) ?? 0) + o.qty)
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([customer, qty]) => ({ customer, qty }))
  }, [orders])

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    function onScroll(e: Event) {
      // Ignore scrolls inside the popup itself
      if (popupRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("scroll", onScroll, true)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("scroll", onScroll, true)
    }
  }, [open])

  function handleToggle() {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      const POPUP_HEIGHT = 260
      const spaceBelow = window.innerHeight - rect.bottom
      const flipUp = spaceBelow < POPUP_HEIGHT && rect.top > POPUP_HEIGHT
      setPopupStyle({
        position: "fixed",
        top: flipUp ? rect.top - POPUP_HEIGHT - 4 : rect.bottom + 4,
        left: rect.left,
        minWidth: 200,
      })
    }
    setOpen((o) => !o)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        className="inline-flex items-center gap-1 text-gray-400 hover:text-brand transition-colors cursor-pointer"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
        </svg>
        <span className="text-xs">{entries.length}</span>
      </button>
      {open && (
        <div
          ref={popupRef}
          style={popupStyle}
          className="z-50 max-h-64 overflow-y-auto rounded-lg border border-cream-border bg-white shadow-lg py-1"
        >
          {entries.map((e) => (
            <div
              key={e.customer}
              className="flex items-center justify-between gap-3 px-3 py-1 text-xs hover:bg-gray-50 whitespace-nowrap"
            >
              <span className="text-foreground truncate">{displayIg(e.customer)}</span>
              <span className="text-gray-500 tabular-nums shrink-0">{e.qty}×</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function ArrivalListClient() {
  const options = useSheetOptions()
  const [items, setItems] = useState<ArrivalListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [selectedEvent, setSelectedEvent] = useState("")
  const [search, setSearch] = useState("")
  const [arrivingItem, setArrivingItem] = useState<ArrivalListItem | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [collapsedEvents, setCollapsedEvents] = useState<Set<string>>(new Set())
  const [collapsedStores, setCollapsedStores] = useState<Set<string>>(new Set())
  // Multi-select for building a cargo document from several items at once.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [cargoOpen, setCargoOpen] = useState(false)

  const fetchItems = useCallback((event?: string, silent = false) => {
    if (!silent) setLoading(true)
    setError("")
    const url = event
      ? `/api/sheets/arrival-list?event=${encodeURIComponent(event)}`
      : "/api/sheets/arrival-list"
    fetchJson<{ items: ArrivalListItem[] }>(url)
      .then((data) => {
        const items = data.items ?? []
        setItems(items)
        // Stores start collapsed (event headers + store headers visible, items
        // hidden). Only on an explicit load — a silent post-mutation refresh
        // leaves whatever the user has expanded alone.
        if (!silent) {
          setCollapsedStores(new Set(items.map((i) => `${i.event}|${i.store || "—"}`)))
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => { if (!silent) setLoading(false) })
  }, [])

  useEffect(() => {
    fetchItems(selectedEvent || undefined)
  }, [fetchItems, selectedEvent])

  // Partial fills change multiple orders' pending qty in non-trivial ways.
  // Refetching is simpler and more correct than incremental local state updates.
  // Silent so the open modal isn't unmounted by the TableSkeleton fallback.
  function handleArrivedSuccess() {
    fetchItems(selectedEvent || undefined, true)
  }

  // Resolve selected keys back to live items (off `items`, not `filteredItems`,
  // so a search-hidden selection still appears in the document). Drops anything
  // no longer pending after a refresh.
  const selectedItems = useMemo(
    () => items.filter((i) => selected.has(selKey(i))),
    [items, selected],
  )

  function toggleSelect(item: ArrivalListItem) {
    setSelected((prev) => {
      const next = new Set(prev)
      const k = selKey(item)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }
  function clearSelection() { setSelected(new Set()) }

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

  if (loading) return <TableSkeleton />

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 flex items-center justify-between gap-3">
        <span>{error}</span>
        <button
          onClick={() => fetchItems(selectedEvent || undefined)}
          className="text-xs px-3 py-1.5 rounded-lg border border-red-300 text-red-700 hover:bg-red-100 transition-colors shrink-0"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search receiving list…"
          className={`${INPUT_CLASS} flex-1 min-w-[180px]`}
        />
        <div style={{ width: "12rem" }}>
          <EventSelect
            value={selectedEvent}
            onChange={(v) => { setSelectedEvent(v); clearSelection() }}
            events={options?.events ?? []}
            placeholder="All Events"
            clearable
          />
        </div>
        <button
          onClick={() => fetchItems(selectedEvent || undefined)}
          title="Refresh"
          className="p-1.5 text-gray-400 hover:text-brand transition-colors rounded"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-6.22-8.56" /><polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
        <button
          onClick={() => setBulkOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-brand text-white hover:bg-brand-hover transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add Bulk Arrival
        </button>
      </div>

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
                  No items pending arrival
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
                    <div className="flex items-center gap-2">
                      {row.item.totalPending > 0 && (
                        <input
                          type="checkbox"
                          checked={selected.has(selKey(row.item))}
                          onChange={() => toggleSelect(row.item)}
                          className="w-4 h-4 shrink-0 accent-brand cursor-pointer"
                          aria-label={`Select ${row.item.productName}`}
                        />
                      )}
                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="text-foreground">{row.item.productName}</span>
                        <CustomerBadge
                          orders={row.item.orders.map((o) => ({ customer: o.customer, qty: o.pending }))}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="tabular-nums font-bold text-foreground">{row.item.totalPending}</span>
                    {row.item.totalPending < row.item.totalBought && (
                      <span className="text-xs text-gray-400 font-normal tabular-nums" title="Partially arrived">
                        {" "}/ {row.item.totalBought}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => setArrivingItem(row.item)}
                      title="Mark as arrived"
                      className="text-gray-400 hover:text-blue-600 transition-colors"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                        <line x1="12" y1="22.08" x2="12" y2="12" />
                      </svg>
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {arrivingItem && (
        <ArriveModal
          item={arrivingItem}
          itemOptions={(options?.items ?? []).map((it) => ({ value: it.name, label: it.name, meta: it.store || undefined }))}
          onClose={() => setArrivingItem(null)}
          onSuccess={() => {
            handleArrivedSuccess()
            setArrivingItem(null)
          }}
        />
      )}

      {bulkOpen && (
        <ArriveBulkModal
          onClose={() => setBulkOpen(false)}
          onProcessed={handleArrivedSuccess}
        />
      )}

      {/* Multi-select action bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-full bg-gray-900 text-white shadow-xl px-4 py-2.5">
          <span className="text-sm tabular-nums">{selected.size} selected</span>
          <button
            onClick={() => setCargoOpen(true)}
            className="px-3 py-1.5 rounded-full bg-brand text-white text-xs font-medium hover:bg-brand-hover transition-colors"
          >
            Create cargo document
          </button>
          <button onClick={clearSelection} aria-label="Clear selection" className="text-white/70 hover:text-white transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      )}

      {cargoOpen && (
        <CargoDocPanel
          items={selectedItems}
          onClose={() => setCargoOpen(false)}
          onGenerated={() => { setCargoOpen(false); clearSelection() }}
        />
      )}
    </>
  )
}

// ─── Cargo document panel ────────────────────────────────────────────────────

// Money with thousands separators and up to 2 decimals (drops trailing zeros).
const fmtValas = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })

// Today in Asia/Jakarta as YYYY-MM-DD, so the document is dated by business day
// regardless of the browser's timezone (matches ReceivedReportControls).
function jakartaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date())
}

// Turn a document name into a safe-ish filename slug; falls back to a default.
function fileSlug(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return slug || "cargo-document"
}

function CargoDocPanel({
  items,
  onClose,
  onGenerated,
}: {
  items: ArrivalListItem[]
  onClose: () => void
  onGenerated: () => void
}) {
  // Qty per selected item, defaulting to remaining-to-arrive. Keyed by selKey.
  const [qtys, setQtys] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const it of items) m[selKey(it)] = String(it.totalPending)
    return m
  })
  const [name, setName] = useState("")
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  // Group by currency for display + subtotals — mirrors the PDF layout, since a
  // single total across currencies (USD + CNY) would be meaningless.
  const byCurrency = useMemo(() => {
    const m = new Map<string, ArrivalListItem[]>()
    for (const it of items) {
      const arr = m.get(it.currency || "") ?? []
      arr.push(it)
      m.set(it.currency || "", arr)
    }
    return m
  }, [items])

  const anyQty = items.some((it) => (Number(qtys[selKey(it)]) || 0) > 0)
  // Currency is shown per line, so the group header only adds value when the
  // document mixes currencies (rare). Mirrors the PDF.
  const multiCurrency = byCurrency.size > 1

  async function handleGenerate() {
    if (!anyQty || generating) return
    setGenerating(true)
    setError(null)
    try {
      const lines = items
        .map((it) => ({
          productName: it.productName,
          qty: Number(qtys[selKey(it)]) || 0,
          valas: it.valas,
          currency: it.currency,
        }))
        .filter((l) => l.qty > 0)
      const trimmedName = name.trim()
      const blob = await generateCargoDocument({ name: trimmedName || undefined, date: jakartaToday(), lines })
      const url = URL.createObjectURL(blob)
      try {
        const a = document.createElement("a")
        a.href = url
        a.download = `${fileSlug(trimmedName)}.pdf`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      } finally {
        URL.revokeObjectURL(url)
      }
      onGenerated()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate document")
      setGenerating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-lg flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-cream-border shrink-0">
          <h3 className="text-sm font-semibold text-foreground">
            Cargo document · {items.length} item{items.length === 1 ? "" : "s"}
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">Adjust quantities if needed. Items are grouped by currency, with a subtotal per currency.</p>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex flex-col gap-4">
          {[...byCurrency.entries()].map(([currency, curItems]) => {
            const subtotal = curItems.reduce(
              (s, it) => s + (Number(qtys[selKey(it)]) || 0) * it.valas,
              0,
            )
            const totalQty = curItems.reduce((s, it) => s + (Number(qtys[selKey(it)]) || 0), 0)
            return (
              <div key={currency || "—"} className="flex flex-col gap-2">
                {multiCurrency && <div className="text-xs font-semibold text-brand">{currency || "—"}</div>}
                {curItems.map((it) => {
                  const k = selKey(it)
                  const qty = Number(qtys[k]) || 0
                  return (
                    <div key={k} className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-foreground break-words">{it.productName}</div>
                        <div className="text-[11px] text-gray-400">
                          {fmtValas(it.valas)} {currency} / unit{it.store ? ` · ${it.store}` : ""}
                        </div>
                      </div>
                      <input
                        type="number"
                        min="1"
                        value={qtys[k] ?? ""}
                        onChange={(e) => setQtys((p) => ({ ...p, [k]: e.target.value }))}
                        className="w-20 shrink-0 border border-cream-border rounded-lg px-2 py-1.5 text-sm text-right bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
                      />
                      <span className="text-xs text-gray-500 tabular-nums w-24 text-right shrink-0">
                        {fmtValas(qty * it.valas)} {currency}
                      </span>
                    </div>
                  )
                })}
                <div className="flex items-center gap-3 border-t border-cream-border pt-1.5 text-xs">
                  <span className="flex-1 min-w-0 font-medium text-gray-500">Subtotal</span>
                  <span className="w-20 text-right font-semibold text-foreground tabular-nums shrink-0">{totalQty}</span>
                  <span className="w-24 text-right font-semibold text-foreground tabular-nums shrink-0">{fmtValas(subtotal)} {currency}</span>
                </div>
              </div>
            )
          })}
        </div>

        <div className="px-5 py-4 border-t border-cream-border shrink-0 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Document name <span className="text-gray-400 font-normal">(optional)</span></span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Cargo to Jakarta — Batch 3"
              className="border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
            />
          </label>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={generating}
              className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating || !anyQty}
              className="px-4 py-1.5 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors"
            >
              {generating ? "Preparing…" : "Download PDF"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Arrive Modal ──────────────────────────────────────────────────────────

function ArriveModal({
  item,
  itemOptions,
  onClose,
  onSuccess,
}: {
  item: ArrivalListItem
  itemOptions: { value: string; label: string; meta?: string }[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [qty, setQty] = useState(String(item.totalPending))
  // "arrive" = normal receipt; "wrong" = different SKU sent; "broken" = arrived
  // damaged/unsellable. Wrong & broken both cancel + refund the picked orders;
  // only "wrong" adds the received SKU to ready stock.
  const [mode, setMode] = useState<"arrive" | "wrong" | "broken" | "missing">("arrive")
  const [receivedItem, setReceivedItem] = useState("")
  // Which waiting customer orders to cancel on a wrong/broken delivery —
  // default all of them (the expected item won't be fulfilled).
  const [cancelIds, setCancelIds] = useState<Set<number>>(() => new Set(item.orders.map((o) => o.id)))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const quantityArrived = Math.max(0, Number(qty) || 0)
  const preview = computeFill(item.orders, quantityArrived)
  // Wrong-product needs a received SKU that differs from the expected one.
  const wrongValid = receivedItem.trim() !== "" && receivedItem !== item.productName

  async function handleSubmit() {
    setSaving(true)
    setSaveError(null)
    try {
      if (mode === "wrong") {
        if (quantityArrived < 1) { setSaveError("Enter how many units arrived."); return }
        if (!wrongValid) {
          setSaveError(
            receivedItem === item.productName
              ? "Received item must differ from the expected one."
              : "Pick the item the supplier actually sent.",
          )
          return
        }
        // Log the received SKU to ready stock and cancel the chosen customer
        // orders. Their invoices drop, so overpayment refunds auto-materialize
        // for anyone who already paid (overseas — the expected item can't be
        // re-ordered).
        const res = await fetch("/api/sheets/arrival-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "wrong_product",
            event: item.event,
            expectedItem: item.productName,
            receivedItem,
            qty: quantityArrived,
            cancelOrderIds: [...cancelIds],
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to log wrong product")
      } else if (mode === "broken") {
        if (quantityArrived < 1) { setSaveError("Enter how many units arrived broken."); return }
        // Broken on arrival: log the broken units to Inventory (flagged broken,
        // never assignable to orders) and cancel the chosen customer orders
        // (refunds auto-materialize if paid).
        const res = await fetch("/api/sheets/arrival-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "broken",
            event: item.event,
            productName: item.productName,
            qty: quantityArrived,
            cancelOrderIds: [...cancelIds],
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to record broken units")
      } else if (mode === "missing") {
        if (cancelIds.size === 0) { setSaveError("Pick at least one order to cancel."); return }
        // Item never arrived: cancel the chosen orders, log nothing to Inventory.
        const res = await fetch("/api/sheets/arrival-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "missing",
            event: item.event,
            cancelOrderIds: [...cancelIds],
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to record missing units")
      } else {
        if (quantityArrived < 1) { setSaveError("Enter how many units arrived."); return }
        const res = await fetch("/api/sheets/arrival-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: item.event,
            productId: item.productId,
            quantityArrived,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to mark as arrived")
      }
      onSuccess()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed")
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
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-sm flex flex-col gap-5 p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
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

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-gray-500">Problem with this delivery?</span>
          <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs">
            {([
              ["arrive", "Arrived OK"],
              ["wrong", "Wrong product"],
              ["broken", "Broken"],
              ["missing", "Missing"],
            ] as const).map(([m, label]) => {
              const active = mode === m
              const activeCls = m === "arrive" ? "bg-blue-600 text-white" : "bg-yellow-500 text-white"
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setMode(m); setSaveError(null) }}
                  className={`flex-1 px-2 py-1.5 transition-colors ${active ? `${activeCls} font-medium` : "bg-white text-gray-600 hover:bg-cream"}`}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Missing logs nothing to inventory, so it has no unit count — the
            cancel list below is the only input. */}
        {mode !== "missing" && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-500">
              {mode === "wrong" ? "Units received (wrong product)" : mode === "broken" ? "Units broken" : "Units arrived"}{" "}
              <span className="text-gray-400">(pending: {item.totalPending})</span>
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
        )}

        {mode !== "arrive" && (
          <>
            {mode === "wrong" && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-yellow-700">Received item (what supplier sent)</label>
                <SearchableSelect
                  value={receivedItem}
                  onChange={(v) => { setReceivedItem(v); setSaveError(null) }}
                  options={itemOptions}
                  placeholder="Search item…"
                />
                <p className="text-[11px] text-gray-400">Logged to Inventory as ready stock.</p>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-yellow-700">Cancel &amp; refund affected orders</label>
              <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto pr-0.5">
                {item.orders.map((o) => (
                  <label key={o.id} className="flex items-center justify-between gap-2 px-2 py-1 rounded-md bg-gray-50 cursor-pointer">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={cancelIds.has(o.id)}
                        onChange={(e) => setCancelIds((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(o.id)
                          else next.delete(o.id)
                          return next
                        })}
                        className="accent-yellow-600"
                      />
                      <span className="truncate text-gray-600">{displayIg(o.customer)}</span>
                    </span>
                    <span className="text-gray-400 tabular-nums shrink-0">{o.pending}×</span>
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-gray-400">
                {mode === "broken"
                  ? "Broken units are logged to Inventory (flagged “broken”, not sellable). Checked orders are removed from the invoice and refunded if paid; unchecked stay pending."
                  : mode === "missing"
                  ? "The item never arrived, so nothing is logged to Inventory. Checked orders are removed from the invoice and refunded if paid; unchecked stay pending."
                  : "Checked orders are removed from the customer’s invoice; a refund appears in the Refunds page if they already paid. Unchecked orders stay pending."}
              </p>
            </div>
          </>
        )}

        {mode === "arrive" && quantityArrived > 0 && (
          <div className="flex flex-col gap-2 text-xs">
            {preview.filled.length > 0 && (
              <div>
                <div className="font-medium text-gray-500 mb-1">Will mark as arrived ({preview.filled.reduce((s, f) => s + f.allocated, 0)} units):</div>
                <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto pr-0.5">
                  {preview.filled.map((f) => (
                    <div key={f.order.id} className="flex items-center justify-between px-2 py-1 rounded-md bg-blue-50">
                      <span className="text-blue-800 truncate">{displayIg(f.order.customer)}</span>
                      <span className="text-blue-700 font-medium ml-2 shrink-0 tabular-nums">
                        {f.allocated}×
                        {f.allocated < f.order.pending && (
                          <span className="text-blue-600/70 font-normal"> of {f.order.pending}</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {preview.unfilled.length > 0 && (
              <div>
                <div className="font-medium text-gray-500 mb-1">Stays in list ({preview.unfilled.reduce((s, o) => s + o.pending, 0)} units):</div>
                <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto pr-0.5">
                  {preview.unfilled.map((o) => (
                    <div key={o.id} className="flex items-center justify-between px-2 py-1 rounded-md bg-gray-50">
                      <span className="text-gray-500 truncate">{displayIg(o.customer)}</span>
                      <span className="text-gray-400 font-medium ml-2 shrink-0 tabular-nums">{o.pending}×</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {preview.unassignedUnits > 0 && (
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-amber-50 border border-amber-200">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-600 shrink-0">
                  <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                </svg>
                <span className="text-amber-700 font-medium">{preview.unassignedUnits} extra units → not assigned (more arrived than expected)</span>
              </div>
            )}
          </div>
        )}

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
            disabled={
              saving ||
              (mode !== "missing" && quantityArrived < 1) ||
              (mode === "wrong" && !wrongValid) ||
              (mode === "missing" && cancelIds.size === 0)
            }
            className={`px-4 py-1.5 rounded-lg text-white text-sm font-medium disabled:opacity-50 transition-colors ${mode === "arrive" ? "bg-blue-600 hover:bg-blue-700" : "bg-yellow-600 hover:bg-yellow-700"}`}
          >
            {saving
              ? "Saving…"
              : mode === "wrong"
                ? "Log Wrong Product"
                : mode === "broken"
                  ? "Log Broken & Cancel"
                  : mode === "missing"
                    ? "Mark Missing & Cancel"
                    : "Mark as Arrived"}
          </button>
        </div>
      </div>
    </div>
  )
}
