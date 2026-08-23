"use client"

import { displayIg, fmt } from "@/lib/format"
import TableSkeleton from "@/components/TableSkeleton"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { ArrivalListItem, ArrivalListOrder, ExcessTransitItem } from "@/lib/db"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { allocateFifo } from "@/lib/fifo-fill"
import { fetchJson } from "@/lib/api-fetch"
import ArriveBulkModal from "./ArriveBulkModal"
import EventSelect from "@/components/EventSelect"
import SearchableSelect from "@/components/SearchableSelect"
import SearchInput from "@/components/SearchInput"
import { FALLBACK_ROUTES, routeOf, routeKeyOf, daysInTransit, transitStatus, type DispatchRoute, type TransitStatus } from "@/lib/dispatch-modes"
import SelectionActionBar from "@/components/SelectionActionBar"
import OverbuyTransitList from "@/components/OverbuyTransitList"
import { groupItems, buildRows, rowKey } from "@/lib/grouped-rows"

function computeFill(orders: ArrivalListOrder[], quantityArrived: number) {
  const { allocations, unallocated, excess } = allocateFifo(orders, (o) => o.pending, quantityArrived)
  return {
    filled: allocations.map(({ item, allocated }) => ({ order: item, allocated })),
    unfilled: unallocated,
    unassignedUnits: excess,
  }
}

// ─── Grouping helpers ───────────────────────────────────────────────────────

/**
 * An item as this screen holds it. `parcel` is set only while a route tab is
 * selected: the row then describes one box rather than the whole item, and the
 * top level of the table groups by that box instead of by trip.
 */
type ArrivalRow = ArrivalListItem & { parcel?: string; parcelSentOn?: string }

/**
 * Stable selection key: event + productId, and the parcel too when one is in
 * play. Without the parcel, a product split between the air box and the sea box
 * would share a key, so ticking the air row would silently tick the sea one.
 */
function selKey(item: Pick<ArrivalRow, "event" | "productId"> & { parcel?: string }): string {
  return `${item.event}|${item.productId}${item.parcel ? `|${item.parcel}` : ""}`
}

function CollapseBtn({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center justify-center w-4 h-4 rounded border border-cream-border bg-white text-muted hover:text-brand hover:border-brand transition-colors text-xs font-bold shrink-0"
    >
      {collapsed ? "+" : "−"}
    </button>
  )
}

// ─── Main component ─────────────────────────────────────────────────────────


/**
 * A parcel's departure date, in a clock coloured by how the journey is going:
 * green while it is within the usual window for its route, amber once it is
 * worth chasing, red when it is a problem.
 *
 * The date sits inside the chip rather than beside it, so a row carrying two
 * parcels reads as two objects rather than a run of numbers.
 */
const TRANSIT_TONE: Record<TransitStatus, string> = {
  // Grey says "nothing to judge by" — no date, or a code on no known route.
  unknown: "border-cream-border bg-surface-muted text-faint",
  ontime: "border-green-200 bg-green-50 text-green-800",
  warn: "border-amber-200 bg-amber-50 text-amber-800",
  late: "border-red-200 bg-red-50 text-red-700",
}

function ScheduleChip({ receipt, sentOn, routes }: { receipt: string; sentOn: string; routes: DispatchRoute[] }) {
  const route = routeOf(receipt, routes)
  const days = daysInTransit(sentOn)
  const status = transitStatus(route, sentOn)
  const label = route?.label ?? "Unknown route"

  // Everything the clock means, in words, on hover. The chip itself stays a
  // colour and a shape: a column of dates is a column of numbers to read, and
  // the point of the clock is that a late box is visible without reading.
  const title = days === null
    ? `${receipt} · ${label} — dispatched before departure dates were recorded`
    : !route
      ? `${receipt} — sent ${sentOn}, ${days} day${days === 1 ? "" : "s"} ago. No route code, so there is no window to judge it by.`
      : [
        `${receipt} · ${label}`,
        `Sent ${sentOn} — ${days} day${days === 1 ? "" : "s"} ago`,
        !route
          ? null
          : status === "late"
            ? `Overdue: past ${route.lateDays} days for this route`
            : status === "warn"
              ? `Running late: past ${route.warnDays} days, chase after ${route.lateDays}`
              : `Normal so far — this route usually lands within ${route.warnDays} days`,
      ].filter(Boolean).join("\n")

  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      {/* Upper-cased on screen, not in the data. Codes typed while packing come
          out as "Box 2" beside an "HC-3101", and a column of parcels reads as
          one kind of thing when they all look alike. What was typed is what is
          stored — matching a route already ignores case. */}
      <span className="text-muted-strong uppercase">{receipt}</span>
      <span
        title={title}
        aria-label={title}
        className={`inline-flex items-center justify-center rounded-full border w-5 h-5 cursor-help ${TRANSIT_TONE[status]}`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </span>
    </span>
  )
}


/**
 * The parcel's code, editable in place.
 *
 * Packing runs ahead of paperwork — a box goes out as "MNC - box 1" and the
 * courier's number arrives later — so the header is where that correction
 * belongs, next to the thing being corrected.
 *
 * It warns before a rename that would change the route, because the route is
 * read from the prefix: replacing "MNC - box 1" with a bare courier number
 * moves the parcel off the Sea tab and into Other. Warned rather than
 * forbidden — it is the owner's box and the owner's naming.
 */
function ParcelEditor({
  receipt, sentOn, routes, onRename,
}: {
  receipt: string
  sentOn: string
  routes: DispatchRoute[]
  onRename: (from: string, to: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(receipt)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const nextRoute = routeOf(value, routes)
  const movesRoute = value.trim() !== "" && nextRoute?.key !== routeOf(receipt, routes)?.key

  async function save() {
    const to = value.trim()
    if (!to || to === receipt) { setEditing(false); setValue(receipt); return }
    setBusy(true); setError("")
    try {
      await onRename(receipt, to)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename")
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    // The code itself is the control. A pencil beside it would be a second
    // thing to aim at for the same job, and this cell is already narrow.
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setValue(receipt); setEditing(true) }}
        title="Click to rename — for when the tracking number arrives later"
        className="flex items-center gap-1.5 rounded-lg -mx-1 px-1 py-0.5 hover:bg-surface-sunken transition-colors text-left"
      >
        <ScheduleChip receipt={receipt} sentOn={sentOn} routes={routes} />
      </button>
    )
  }

  return (
    // Stacked, not squeezed: the column is 40 units wide and a field plus two
    // buttons on one line does not fit inside it — they ended up under the
    // Store heading. The field takes the width it has, the actions sit beneath.
    <span className="flex flex-col gap-1 max-w-full" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save()
          if (e.key === "Escape") { setEditing(false); setValue(receipt); setError("") }
        }}
        placeholder="Tracking no."
        className="w-full min-w-0 border border-cream-border rounded-lg px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
      />
      <span className="flex items-center gap-2">
        <button
          type="button" onClick={save} disabled={busy}
          className="text-xs font-semibold text-brand disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => { setEditing(false); setValue(receipt); setError("") }}
          className="text-xs text-faint hover:text-muted"
        >
          Cancel
        </button>
      </span>
      {movesRoute && (
        <span className="text-[11px] text-amber-700 leading-tight">
          Moves to {nextRoute?.label ?? "Other"}
        </span>
      )}
      {error && <span className="text-[11px] text-red-600 leading-tight">{error}</span>}
    </span>
  )
}

export default function ArrivalListClient() {
  const options = useSheetOptions()
  const [items, setItems] = useState<ArrivalListItem[]>([])
  const [excessPending, setExcessPending] = useState<ExcessTransitItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [selectedEvent, setSelectedEvent] = useState("")
  const [search, setSearch] = useState("")
  /**
   * Which route to show, read off each line's dispatch receipt — HC by
   * suitcase, CJI by air, MNC by sea. A parcel arrives as one box, and this
   * is how the bench sees what should have been in it.
   */
  // Air cargo by default. "All" is every parcel still in transit across every
  // event, which is the largest view and rarely the one you opened the page for.
  const [route, setRoute] = useState<string>("cji")
  /**
   * The routes as Settings has them. Falls back to the built-in three until
   * the fetch lands, so the tabs never flash empty; a changed prefix simply
   * appears a moment later.
   */
  const [routes, setRoutes] = useState<DispatchRoute[]>(FALLBACK_ROUTES)

  useEffect(() => {
    fetch("/api/sheets/dispatch-routes", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { routes?: DispatchRoute[] }) => { if (d.routes?.length) setRoutes(d.routes) })
      // A failed load leaves the fallback in place: filing parcels under the
      // usual codes beats an empty screen.
      .catch(() => {})
  }, [])

  /** All / one per configured route / Other, which hides itself while empty. */
  const routeTabs = useMemo(
    () => [
      { key: "all", label: "All" },
      ...routes.map((r) => ({ key: r.key, label: r.label })),
      { key: "other", label: "Other" },
    ],
    [routes],
  )
  const [arrivingItem, setArrivingItem] = useState<ArrivalListItem | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [collapsedEvents, setCollapsedEvents] = useState<Set<string>>(new Set())
  const [collapsedStores, setCollapsedStores] = useState<Set<string>>(new Set())
  // Desktop's own collapse state — separate from the mobile cards' above, which start
  // every store collapsed. Desktop stays fully expanded by default (never seeded), since
  // a spreadsheet-style table reads better open than the phone card list does.
  const [collapsedDesktopEvents, setCollapsedDesktopEvents] = useState<Set<string>>(new Set())
  const [collapsedDesktopStores, setCollapsedDesktopStores] = useState<Set<string>>(new Set())
  // Multi-select for marking several items received.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [notReceivedOpen, setNotReceivedOpen] = useState(false)

  const fetchItems = useCallback((event?: string, silent = false) => {
    if (!silent) setLoading(true)
    setError("")
    const url = event
      ? `/api/sheets/arrival-list?event=${encodeURIComponent(event)}`
      : "/api/sheets/arrival-list"
    fetchJson<{ items: ArrivalListItem[]; excessPending?: ExcessTransitItem[] }>(url)
      .then((data) => {
        const items = data.items ?? []
        setItems(items)
        setExcessPending(data.excessPending ?? [])
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

  function toggleDesktopEvent(event: string) {
    setCollapsedDesktopEvents((prev) => {
      const next = new Set(prev)
      next.has(event) ? next.delete(event) : next.add(event)
      return next
    })
  }

  function toggleDesktopStore(event: string, store: string) {
    const key = `${event}|${store}`
    setCollapsedDesktopStores((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  /** How many lines are waiting on each route, for the counts on the tabs. */
  const routeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: 0, other: 0 }
    for (const r of routes) counts[r.key] = 0
    for (const item of items) {
      counts.all += 1
      const modes = new Set(item.orders.map((o) => routeKeyOf(o.dispatchReceipt, routes)))
      // An item can span two parcels — half flown, half shipped — so it counts
      // once against each route it is actually travelling on.
      for (const m of modes) counts[m] = (counts[m] ?? 0) + 1
    }
    return counts
  }, [items, routes])

  const filteredItems = useMemo<ArrivalRow[]>(() => {
    const q = search.trim().toLowerCase()
    const matchesSearch = (i: ArrivalRow) => !q
      || i.productName.toLowerCase().includes(q)
      || i.event.toLowerCase().includes(q)
      || (i.store ?? "").toLowerCase().includes(q)
      || i.orders.some((o) => o.dispatchReceipt.toLowerCase().includes(q))

    if (route === "all") return items.filter(matchesSearch)

    // Narrowed to one route, a row must describe THAT parcel and nothing else.
    // Filtering which rows to show is not enough: an item split between two
    // boxes would keep reporting its full quantity and every customer, so
    // opening the air cargo would list seven units when only three flew — and
    // the four still at sea would be hunted for on the bench.
    // One row per box, not per item: a route can hold several parcels, and a
    // product may sit in two of them. Splitting here is what lets the table
    // group by receipt below — and what makes each row's quantity, customers
    // and order ids describe the box in front of you.
    return items.reduce<ArrivalRow[]>((out, item) => {
      const byParcel = new Map<string, typeof item.orders>()
      for (const o of item.orders) {
        if (routeKeyOf(o.dispatchReceipt, routes) !== route) continue
        const key = o.dispatchReceipt || "—"
        byParcel.set(key, [...(byParcel.get(key) ?? []), o])
      }
      for (const [parcel, orders] of byParcel) {
        const projected: ArrivalRow = {
          ...item,
          parcel,
          // A receipt is one box that left once, so any of its lines carries
          // the date; the first is as good as another.
          parcelSentOn: orders[0]?.dispatchedAt ?? "",
          orders,
          totalPending: orders.reduce((n, o) => n + o.pending, 0),
          totalBought: orders.reduce((n, o) => n + o.unitBuy, 0),
        }
        if (matchesSearch(projected)) out.push(projected)
      }
      return out
    }, [])
  }, [items, search, route])

  /**
   * Resolved against the rows on screen, not the raw list.
   *
   * Under a route those rows are projected onto one parcel and their selection
   * key carries it, so matching against `items` — which has no parcel — found
   * nothing and the bulk dialogs opened over zero items with no quantities to
   * adjust. Selecting acts on what you can see, which is also what makes
   * receiving apply to that box alone.
   */
  const selectedItems = useMemo(
    () => filteredItems.filter((i) => selected.has(selKey(i))),
    [filteredItems, selected],
  )

  const grouped = useMemo(
    () => groupItems(filteredItems, route === "all" ? undefined : (i) => i.parcel ?? "—"),
    [filteredItems, route],
  )

  /** The date each parcel left, so a group header can carry its clock. */
  const parcelDates = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of filteredItems) if (i.parcel && !m.has(i.parcel)) m.set(i.parcel, i.parcelSentOn ?? "")
    return m
  }, [filteredItems])

  /**
   * What the first column says. Under "All" that is the trip; under a route it
   * is the box — receipt and clock — because the question there is "what is in
   * this parcel", and the trip is a detail of the lines inside it.
   */
  const groupLabel = (key: string) =>
    route === "all"
      ? <span className="font-medium text-foreground">{key}</span>
      : <ParcelEditor receipt={key} sentOn={parcelDates.get(key) ?? ""} routes={routes} onRename={renameParcel} />

  /**
   * Rename a whole parcel. Refetches rather than patching state: the rename
   * moves every line of the box at once, and may move the box to another tab
   * if the new code reads as a different route.
   */
  const renameParcel = useCallback(async (from: string, to: string) => {
    const res = await fetch("/api/sheets/arrival-list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rename_receipt", from, to }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? "Could not rename")
    clearSelection()
    fetchItems(selectedEvent || undefined, true)
  }, [fetchItems, selectedEvent])

  // Desktop-only state (see above) — mobile's own render loop reads collapsedEvents/
  // collapsedStores directly, not through `rows`.
  const rows = useMemo(
    () => buildRows(grouped, collapsedDesktopEvents, collapsedDesktopStores),
    [grouped, collapsedDesktopEvents, collapsedDesktopStores],
  )

  // Select-all over the currently-visible (search-filtered) items.
  const allSelected = filteredItems.length > 0 && filteredItems.every((i) => selected.has(selKey(i)))
  const toggleSelectAll = () => setSelected(() => (allSelected ? new Set() : new Set(filteredItems.map(selKey))))

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
      {/* Which parcel to check in. The route is read off each line's dispatch
          receipt, so picking one shows exactly what should have travelled
          together — the hand-carried suitcase, the air cargo, the sea box.
          Same segmented bar as the Payments type filter, so the two screens
          are operated the same way. */}
      <div className="flex items-center gap-1 w-full rounded-xl border border-cream-border bg-white p-1 mb-3 overflow-x-auto">
        {routeTabs.map(({ key, label }) => {
          const count = routeCounts[key] ?? 0
          // "Other" catches an unrecognised prefix — a typo, usually. It stays
          // out of the bar while empty rather than offering a tab that shows
          // nothing.
          if (key === "other" && count === 0) return null
          const active = route === key
          return (
            <button
              key={key}
              type="button"
              // The collapse sets are keyed by whatever the first column groups
              // by, and that changes with the tab: trip codes under "All",
              // receipt codes under a route. Carrying the old keys over means
              // they match nothing, so every group silently reopens — and
              // collapses again when you switch back. Reset with the tab.
              onClick={() => {
                setRoute(key)
                clearSelection()
                setCollapsedDesktopEvents(new Set())
                setCollapsedDesktopStores(new Set())
              }}
              className={`flex-1 shrink-0 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                active ? "bg-brand text-white" : "text-muted hover:text-foreground"
              }`}
            >
              {label}
              <span className={`tabular-nums text-xs ${active ? "text-white/70" : "text-faint"}`}>{count}</span>
            </button>
          )
        })}
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search receiving list…"
          className="flex-1 min-w-0 sm:min-w-[180px]"
        />
        <div className="w-40 shrink-0 sm:w-[12rem]">
          <EventSelect
            value={selectedEvent}
            onChange={(v) => { setSelectedEvent(v); clearSelection() }}
            events={options?.events ?? []}
            placeholder="All Events"
            clearable
          />
        </div>
        {/* Select-all toggle, right of the event filter (both layouts). */}
        <button
          type="button"
          onClick={toggleSelectAll}
          aria-label={allSelected ? "Deselect all" : "Select all"}
          title={allSelected ? "Deselect all" : "Select all"}
          className="inline-flex items-center gap-1.5 shrink-0 rounded-lg border border-cream-border h-[38px] px-3 text-sm text-muted-strong bg-white hover:border-brand hover:text-brand transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          {allSelected && <span className="w-1.5 h-1.5 rounded-full bg-brand" />}
        </button>
        <button
          onClick={() => setBulkOpen(true)}
          className="hidden md:inline-flex items-center gap-1.5 h-[38px] px-4 text-sm font-medium rounded-lg bg-brand text-white hover:bg-brand-dark transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add Bulk Arrival
        </button>
      </div>

      {/* Mobile add FAB */}
      <button
        type="button"
        onClick={() => setBulkOpen(true)}
        aria-label="Add bulk arrival"
        className="md:hidden fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90"
      >
        +
      </button>

      {/* Grouped table (desktop) */}
      <div className="hidden md:block rounded-xl border border-cream-border bg-white overflow-hidden">
        {/* Same title-bar style as OverbuyTransitList's "INVENTORY AWAITING ARRIVAL"
            below, so the two sections read as one matched pair. */}
        <div className="px-4 py-2.5 border-b border-cream-border border-l-[3px] border-brand bg-cream">
          <div className="font-bold text-sm text-foreground">CUSTOMER ORDER</div>
        </div>
        {/* table-fixed: locks Event/Store/Receipt/Qty/action to their declared
            widths regardless of content, so Receipt's truncate actually clips
            (it silently didn't under auto layout) and Qty/action never get
            pushed out of view — no horizontal scroll, no wrap. Product takes
            what's left, and clips: table-fixed sizes a cell but does not clip
            it, so a long name painted straight over the Receipt column until
            the cell got overflow-hidden and the name got truncate. */}
        <table className="w-full text-sm border-collapse table-fixed">
          <thead>
            <tr className="border-b border-cream-border bg-surface-muted/80">
              {/* The first column is the trip under "All" and the parcel under a
                  route — a trip name like POCN202603, or a receipt plus its
                  clock. One width for both, wide enough for either: sizing it
                  per tab slid every other column sideways on a tab switch. */}
              <th className="text-left px-4 py-2.5 font-medium text-muted w-44">
                {route === "all" ? "Event" : "Parcel"}
              </th>
              <th className="text-left px-4 py-2.5 font-medium text-muted w-36">Store</th>
              <th className="text-left px-4 py-2.5 font-medium text-muted">Product</th>
              {/* One width for both views — a receipt with its clock under
                  "All", a whole trip code under a route. Switching tabs should
                  not shift the columns under your eye. */}
              <th className="text-left px-4 py-2.5 font-medium text-muted w-40">
                {route === "all" ? "Receipt" : "Event"}
              </th>
              <th className="text-right px-4 py-2.5 font-medium text-muted w-14">Qty</th>
              <th className="px-4 py-2.5 w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-faint py-12 text-sm">
                  No items pending arrival
                </td>
              </tr>
            )}
            {rows.map((row) => {
              if (row.type === "event-collapsed") {
                return (
                  <tr key={`${row.event}~collapsed`} className="border-b border-cream-border">
                    <td colSpan={6} className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <CollapseBtn collapsed onClick={() => toggleDesktopEvent(row.event)} />
                        {groupLabel(row.event)}
                        <span className="text-xs text-faint">{row.totalItems} items</span>
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
                          <CollapseBtn collapsed={false} onClick={() => toggleDesktopEvent(row.event)} />
                          {groupLabel(row.event)}
                        </div>
                      </td>
                    )}
                    <td colSpan={5} className="px-4 py-2.5 bg-surface-muted/40">
                      <div className="flex items-center gap-2">
                        <CollapseBtn collapsed onClick={() => toggleDesktopStore(row.event, row.store)} />
                        <span className="text-muted-strong">{row.store}</span>
                        <span className="text-xs text-faint">{row.totalItems} items</span>
                      </div>
                    </td>
                  </tr>
                )
              }

              return (
                <tr
                  key={rowKey(row.event, row.store, row.item)}
                  className="border-b border-cream-border hover:bg-surface-muted/50 transition-colors"
                >
                  {row.showEvent && (
                    <td rowSpan={row.eventRowSpan} className="px-4 py-2.5 align-top border-r border-cream-border">
                      <div className="flex items-center gap-2 pt-0.5">
                        <CollapseBtn collapsed={false} onClick={() => toggleDesktopEvent(row.event)} />
                        {groupLabel(row.event)}
                      </div>
                    </td>
                  )}
                  {row.showStore && (
                    <td rowSpan={row.storeRowSpan} className="px-4 py-2.5 align-top border-r border-cream-border">
                      <div className="flex items-center gap-2 pt-0.5">
                        <CollapseBtn collapsed={false} onClick={() => toggleDesktopStore(row.event, row.store)} />
                        <span className="text-muted-strong">{row.store}</span>
                      </div>
                    </td>
                  )}
                  <td className="px-4 py-2.5 overflow-hidden">
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
                        <span className="text-foreground truncate">{row.item.productName}</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {(() => {
                      // Under a route the parcel is the group header, so
                      // repeating it here would say the same thing twice; the
                      // trip is the useful detail instead. Under "All" a row
                      // can span parcels, and each carries its own date and
                      // verdict — a box that flew is overdue long before one
                      // on a boat is.
                      if (route !== "all") {
                        return <span className="block whitespace-nowrap">{row.item.event}</span>
                      }
                      const parcels = new Map<string, string>()
                      for (const o of row.item.orders) {
                        if (o.dispatchReceipt && !parcels.has(o.dispatchReceipt)) {
                          parcels.set(o.dispatchReceipt, o.dispatchedAt ?? "")
                        }
                      }
                      if (parcels.size === 0) return <span className="block truncate">—</span>
                      return (
                        <div className="flex flex-col gap-1">
                          {[...parcels].map(([receipt, sentOn]) => (
                            <ScheduleChip key={receipt} receipt={receipt} sentOn={sentOn} routes={routes} />
                          ))}
                        </div>
                      )
                    })()}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <span className="tabular-nums font-bold text-foreground">{row.item.totalPending}</span>
                    {row.item.totalPending < row.item.totalBought && (
                      <span className="text-faint font-normal tabular-nums" title="Partially arrived">
                        {" "}/ {row.item.totalBought}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => setArrivingItem(row.item)}
                      title="Mark as arrived"
                      className="text-faint hover:text-blue-600 transition-colors"
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

      {/* Grouped cards (mobile) */}
      <div className="md:hidden flex flex-col gap-2.5">
        {grouped.size === 0 && (
          <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-faint">No items pending arrival</div>
        )}
        {[...grouped.entries()].map(([event, storeMap]) => {
          const allItems = [...storeMap.values()].flat()
          const eventCollapsed = collapsedEvents.has(event)
          return (
            <div key={event} className="rounded-xl border border-cream-border bg-white overflow-hidden">
              <button type="button" onClick={() => toggleEvent(event)} className="w-full flex items-center gap-2.5 px-4 py-3 border-l-[3px] border-brand text-left">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`text-faint transition-transform ${eventCollapsed ? "-rotate-90" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
                {route === "all"
                  ? <span className="font-bold text-sm text-foreground">{event}</span>
                  : <ScheduleChip receipt={event} sentOn={parcelDates.get(event) ?? ""} routes={routes} />}
                <span className="ml-auto text-xs text-faint">{allItems.length} items</span>
              </button>
              {!eventCollapsed && [...storeMap.entries()].map(([store, storeItems]) => {
                const storeKey = `${event}|${store}`
                const storeCollapsed = collapsedStores.has(storeKey)
                return (
                  <div key={storeKey}>
                    <button type="button" onClick={() => toggleStore(event, store)} className="w-full flex items-center gap-2 px-4 py-2.5 bg-surface-muted/60 border-t border-cream-border text-left">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`text-faint transition-transform ${storeCollapsed ? "-rotate-90" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
                      <span className="text-xs font-bold text-muted-strong">{store}</span>
                      <span className="ml-auto text-[11px] text-faint">{storeItems.length}</span>
                    </button>
                    {!storeCollapsed && storeItems.map((item) => (
                      <div key={item.productId} className="flex items-center gap-3 px-4 py-2.5 border-t border-cream-border">
                        {item.totalPending > 0 && (
                          <input
                            type="checkbox"
                            checked={selected.has(selKey(item))}
                            onChange={() => toggleSelect(item)}
                            className="w-5 h-5 shrink-0 accent-brand"
                            aria-label={`Select ${item.productName}`}
                          />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-foreground">{item.productName}</div>
                          <div className="mt-0.5">
                          </div>
                        </div>
                        <div className="text-sm font-bold tabular-nums whitespace-nowrap text-foreground">
                          {item.totalPending}
                          {item.totalPending < item.totalBought && (
                            <span className="text-faint font-normal" title="Partially arrived"> / {item.totalBought}</span>
                          )}
                        </div>
                        <button type="button" onClick={() => setArrivingItem(item)} aria-label="Mark as arrived" className="w-9 h-9 rounded-lg border border-cream-border text-brand flex items-center justify-center shrink-0 active:bg-blue-50 active:text-blue-700 active:border-blue-200">
                          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                            <line x1="12" y1="22.08" x2="12" y2="12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      <OverbuyTransitList
        items={excessPending}
        stage="arrive"
        onMarked={() => fetchItems(selectedEvent || undefined, true)}
      />

      {arrivingItem && (
        <ArriveModal
          item={arrivingItem}
          itemOptions={(options?.items ?? []).map((it) => ({ value: it.name, label: it.name, meta: `Rp ${fmt(it.price)}` }))}
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
        <SelectionActionBar
          reserveFab
          count={selected.size}
          onClear={clearSelection}
          actions={[
            {
              label: "Received",
              color: "blue",
              onClick: () => setReceiveOpen(true),
              icon: (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                  <path d="m3.3 7 8.7 5 8.7-5" />
                  <path d="M12 22V12" />
                </svg>
              ),
            },
            {
              label: "Not Received",
              color: "amber",
              onClick: () => setNotReceivedOpen(true),
              icon: (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              ),
            },
          ]}
        />
      )}

      {receiveOpen && (
        <ConfirmReceivePanel
          items={selectedItems}
          onClose={() => setReceiveOpen(false)}
          onSuccess={() => { clearSelection(); setReceiveOpen(false); handleArrivedSuccess() }}
          onPartial={(succeededKeys) => {
            setSelected((prev) => {
              const next = new Set(prev)
              for (const k of succeededKeys) next.delete(k)
              return next
            })
            handleArrivedSuccess()
          }}
        />
      )}

      {notReceivedOpen && (
        <NotReceivedPanel
          items={selectedItems}
          itemOptions={(options?.items ?? []).map((it) => ({ value: it.name, label: it.name, meta: `Rp ${fmt(it.price)}` }))}
          onClose={() => setNotReceivedOpen(false)}
          onSuccess={() => { clearSelection(); setNotReceivedOpen(false); handleArrivedSuccess() }}
          onPartial={(succeededKeys) => {
            setSelected((prev) => {
              const next = new Set(prev)
              for (const k of succeededKeys) next.delete(k)
              return next
            })
            handleArrivedSuccess()
          }}
        />
      )}
    </>
  )
}

// ─── Confirm multi-receive panel ─────────────────────────────────────────────

function ConfirmReceivePanel({
  items,
  onClose,
  onSuccess,
  onPartial,
}: {
  items: ArrivalListItem[]
  onClose: () => void
  onSuccess: () => void
  onPartial: (succeededKeys: string[]) => void
}) {
  // Qty per selected item, defaulting to its pending units. Keyed by selKey.
  const [qtys, setQtys] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const it of items) m[selKey(it)] = String(it.totalPending)
    return m
  })
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  // Group by event for display, mirroring the shopping list's purchase panel.
  const byEvent = useMemo(() => {
    const m = new Map<string, ArrivalListItem[]>()
    for (const it of items) {
      const arr = m.get(it.event) ?? []
      arr.push(it)
      m.set(it.event, arr)
    }
    return m
  }, [items])

  const totalQty = items.reduce((s, it) => s + (Number(qtys[selKey(it)]) || 0), 0)
  const anyQty = totalQty > 0

  async function handleSubmit() {
    if (!anyQty || submitting) return
    setSubmitting(true)
    setErrors([])

    // The arrival API is per-product, so fire one request per selected item.
    const targets = items
      .map((it) => ({
        key: selKey(it),
        event: it.event,
        productId: it.productId,
        name: it.productName,
        qty: Number(qtys[selKey(it)]) || 0,
      }))
      .filter((t) => t.qty > 0)

    const settled = await Promise.allSettled(
      targets.map((t) =>
        fetch("/api/sheets/arrival-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event: t.event, productId: t.productId, quantityArrived: t.qty }),
        }).then(async (res) => {
          const data = await res.json()
          if (!res.ok) throw new Error(data.error ?? `Failed for ${t.name}`)
          return t.key
        }),
      ),
    )

    const succeeded: string[] = []
    const failed: string[] = []
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") succeeded.push(targets[i].key)
      else failed.push(`${targets[i].name}: ${r.reason instanceof Error ? r.reason.message : "failed"}`)
    })

    setSubmitting(false)
    if (failed.length === 0) {
      onSuccess()
    } else {
      setErrors(failed)
      if (succeeded.length > 0) onPartial(succeeded)
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
            Mark {totalQty} item{totalQty === 1 ? "" : "s"} received
          </h3>
          <p className="text-xs text-muted mt-0.5">Adjust quantities if needed. Units are assigned to waiting customers, highest-priority first.</p>
        </div>

        <div className="px-5 py-4 overflow-y-auto min-h-0 flex flex-col gap-4">
          {[...byEvent.entries()].map(([event, evItems]) => (
            <div key={event} className="flex flex-col gap-2">
              <div className="text-xs font-semibold text-muted">{event}</div>
              {evItems.map((it) => {
                const k = selKey(it)
                return (
                  <div key={k} className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-foreground break-words">{it.productName}</div>
                      {it.store && <div className="text-[11px] text-faint">{it.store}</div>}
                    </div>
                    <input
                      type="number"
                      min="1"
                      value={qtys[k] ?? ""}
                      onChange={(e) => setQtys((p) => ({ ...p, [k]: e.target.value }))}
                      className="w-20 shrink-0 border border-cream-border rounded-lg px-2 py-1.5 text-sm text-right bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
                    />
                    <span className="text-[11px] text-faint w-16 shrink-0">/ {it.totalPending} pending</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-cream-border shrink-0 flex flex-col gap-3">
          {errors.length > 0 && (
            <div className="text-xs text-red-600">
              <div className="font-medium">Some items failed (others were recorded):</div>
              <ul className="list-disc pl-4">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !anyQty}
              className="px-4 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {submitting ? "Saving…" : "Mark received"}
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
  // damaged/unsellable; "cancelled" = customer backed out after we already
  // bought it (correct item, no delivery problem). Wrong, broken & cancelled
  // all cancel + refund the picked orders; wrong and cancelled additionally
  // log ready stock (the received SKU, or the already-bought units).
  const [mode, setMode] = useState<"arrive" | "wrong" | "broken" | "missing" | "cancelled">("arrive")
  const [receivedItem, setReceivedItem] = useState("")
  // Which waiting customer orders to cancel on a wrong/broken delivery —
  // default all of them (the expected item won't be fulfilled).
  const [cancelIds, setCancelIds] = useState<Set<number>>(() => new Set(item.orders.map((o) => o.id)))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Receipt tagging the returned-to-inventory stock on a customer cancellation.
  // Defaults to the checked orders' customer usernames (tracks the checkboxes
  // until the operator edits it).
  const [receipt, setReceipt] = useState("")
  const [receiptTouched, setReceiptTouched] = useState(false)

  const quantityArrived = Math.max(0, Number(qty) || 0)
  const preview = computeFill(item.orders, quantityArrived)

  // Distinct usernames of the currently-checked orders, joined — the default
  // receipt for the customer-cancelled path.
  const cancelledCustomers = useMemo(() => {
    const seen = new Set<string>()
    const names: string[] = []
    for (const o of item.orders) {
      if (cancelIds.has(o.id) && !seen.has(o.customer)) { seen.add(o.customer); names.push(o.customer) }
    }
    return names.join(", ")
  }, [item.orders, cancelIds])
  const receiptValue = receiptTouched ? receipt : cancelledCustomers
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
      } else if (mode === "cancelled") {
        if (cancelIds.size === 0) { setSaveError("Pick at least one order to cancel."); return }
        // Customer backed out after we already bought their item — it's
        // correct, sellable stock, not broken or missing. Log the
        // already-bought units to Inventory as ready stock and cancel the
        // chosen orders (refunds auto-materialize if paid).
        const res = await fetch("/api/sheets/arrival-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "customer_cancelled",
            event: item.event,
            productName: item.productName,
            receipt: receiptValue,
            cancelOrderIds: [...cancelIds],
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to record cancellation")
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
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-sm flex flex-col gap-4 p-6 h-[min(37rem,90vh)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 shrink-0">
          <div>
            <div className="text-sm font-semibold text-foreground">{item.productName}</div>
            <div className="text-xs text-faint mt-0.5">
              {item.event}{item.store ? ` · ${item.store}` : ""}
            </div>
          </div>
          <button onClick={onClose} className="text-faint hover:text-brand transition-colors shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Fixed-height dialog: this is the only scrollable region, so the
            modal itself is always the same height no matter which tab (and
            its content length) is active. */}
        <div className="flex-1 overflow-y-auto min-h-0 flex flex-col gap-5 -mr-2 pr-2">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">What happened?</span>
          <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs">
            {([
              ["arrive", "Arrived"],
              ["wrong", "Wrong"],
              ["broken", "Broken"],
              ["missing", "Missing"],
              ["cancelled", "Cancelled"],
            ] as const).map(([m, label]) => {
              const active = mode === m
              const activeCls = m === "arrive" ? "bg-blue-600 text-white" : "bg-yellow-500 text-white"
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m)
                    setSaveError(null)
                    // "Cancelled" is almost always a single customer, not the
                    // whole waiting list — start empty instead of defaulting
                    // to the all-selected behavior the delivery-problem modes use.
                    setCancelIds(m === "cancelled" ? new Set() : new Set(item.orders.map((o) => o.id)))
                  }}
                  className={`flex-1 px-2 py-1.5 whitespace-nowrap transition-colors ${active ? `${activeCls} font-medium` : "bg-white text-muted-strong hover:bg-cream"}`}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Missing and Cancelled derive their qty from the checked orders below
            (pending / unit_buy) instead of a typed count — shown here read-only
            so the row layout matches Wrong/Broken/Arrived OK. */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted">
            {mode === "wrong" ? "Units received (wrong product)" : mode === "broken" ? "Units broken" : mode === "missing" ? "Units missing" : mode === "cancelled" ? "Units cancelled" : "Units arrived"}{" "}
            <span className="text-faint">(pending: {item.totalPending})</span>
          </label>
          {mode === "missing" || mode === "cancelled" ? (
            <div className="border border-cream-border rounded-lg px-3 py-2 text-sm bg-cream/50 text-muted tabular-nums">
              {mode === "missing"
                ? item.orders.filter((o) => cancelIds.has(o.id)).reduce((s, o) => s + o.pending, 0)
                : item.orders.filter((o) => cancelIds.has(o.id)).reduce((s, o) => s + o.unitBuy, 0)}{" "}
              <span className="text-faint">(from checked orders below)</span>
            </div>
          ) : (
            <input
              type="number"
              min="1"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); if (e.key === "Escape") onClose() }}
              autoFocus
              className="border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
            />
          )}
        </div>

        {mode !== "arrive" && (
          <>
            {/* Reserved even outside "wrong" mode (just hidden) so switching
                tabs doesn't change the modal's height. */}
            <div className={`flex flex-col gap-1.5 ${mode === "wrong" ? "" : "invisible"}`} aria-hidden={mode !== "wrong"}>
              <label className="text-xs font-medium text-yellow-700">Received item (what supplier sent)</label>
              <SearchableSelect
                value={receivedItem}
                onChange={(v) => { setReceivedItem(v); setSaveError(null) }}
                options={itemOptions}
                placeholder="Search item…"
              />
              <p className="text-[11px] text-faint">Logged to Inventory as ready stock.</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-yellow-700">Affected orders</label>
              <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto pr-0.5">
                {item.orders.map((o) => (
                  <label key={o.id} className="flex items-center justify-between gap-2 px-2 py-1 rounded-lg bg-surface-muted cursor-pointer">
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
                      <span className="truncate text-muted-strong">{displayIg(o.customer)}</span>
                    </span>
                    <span className="text-faint tabular-nums shrink-0">
                      {mode === "cancelled" ? o.unitBuy : o.pending}×
                    </span>
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-faint">
                {mode === "broken"
                  ? "Broken units are logged to Inventory (flagged “broken”, not sellable). "
                  : mode === "missing"
                  ? "The item never arrived, so nothing is logged to Inventory. "
                  : mode === "cancelled"
                  ? `The units already bought for checked orders (${item.orders.filter((o) => cancelIds.has(o.id)).reduce((s, o) => s + o.unitBuy, 0)} total) are logged to Inventory as ready stock, assignable to the next customer who wants this item. `
                  : ""}
                Checked orders are removed from the invoice and refunded if paid; unchecked orders stay pending.
              </p>
              {mode === "cancelled" && (
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-yellow-700">
                    Inventory receipt <span className="text-faint font-normal">(tags the returned stock)</span>
                  </label>
                  <input
                    type="text"
                    value={receiptValue}
                    onChange={(e) => { setReceipt(e.target.value); setReceiptTouched(true) }}
                    disabled={saving}
                    placeholder="e.g. customer username"
                    className="w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
                  />
                </div>
              )}
            </div>
          </>
        )}

        {mode === "arrive" && quantityArrived > 0 && (
          <div className="flex flex-col gap-2 text-xs">
            {preview.filled.length > 0 && (
              <div>
                <div className="font-medium text-muted mb-1">Will mark as arrived ({preview.filled.reduce((s, f) => s + f.allocated, 0)} units):</div>
                <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto pr-0.5">
                  {preview.filled.map((f) => (
                    <div key={f.order.id} className="flex items-center justify-between px-2 py-1 rounded-lg bg-blue-50">
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
                <div className="font-medium text-muted mb-1">Stays in list ({preview.unfilled.reduce((s, o) => s + o.pending, 0)} units):</div>
                <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto pr-0.5">
                  {preview.unfilled.map((o) => (
                    <div key={o.id} className="flex items-center justify-between px-2 py-1 rounded-lg bg-surface-muted">
                      <span className="text-muted truncate">{displayIg(o.customer)}</span>
                      <span className="text-faint font-medium ml-2 shrink-0 tabular-nums">{o.pending}×</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {preview.unassignedUnits > 0 && (
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-amber-50 border border-amber-200">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-600 shrink-0">
                  <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                </svg>
                <span className="text-amber-700 font-medium">{preview.unassignedUnits} extra units → not assigned (more arrived than expected)</span>
              </div>
            )}
          </div>
        )}
        </div>

        <div className="flex items-center justify-end gap-2 shrink-0 pt-3 border-t border-cream-border">
          {saveError && <p className="text-xs text-red-500 mr-auto">{saveError}</p>}
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={
              saving ||
              (mode !== "missing" && mode !== "cancelled" && quantityArrived < 1) ||
              (mode === "wrong" && !wrongValid) ||
              ((mode === "missing" || mode === "cancelled") && cancelIds.size === 0)
            }
            className={`px-4 py-1.5 rounded-lg text-white text-sm font-medium disabled:opacity-50 transition-colors ${mode === "arrive" ? "bg-blue-600 hover:bg-blue-700" : "bg-yellow-600 hover:bg-yellow-700"}`}
          >
            {saving
              ? "Saving…"
              : mode === "wrong"
                ? "Log wrong & cancel"
                : mode === "broken"
                  ? "Log broken & cancel"
                  : mode === "missing"
                    ? "Mark missing & cancel"
                    : mode === "cancelled"
                      ? "Log to inventory & cancel"
                      : "Mark arrived"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Not Received panel (bulk delivery problems) ─────────────────────────────

type NotReceivedMode = "wrong" | "broken" | "missing" | "cancelled"

function NotReceivedPanel({
  items,
  itemOptions,
  onClose,
  onSuccess,
  onPartial,
}: {
  items: ArrivalListItem[]
  itemOptions: { value: string; label: string; meta?: string }[]
  onClose: () => void
  onSuccess: () => void
  onPartial: (succeededKeys: string[]) => void
}) {
  const [mode, setMode] = useState<NotReceivedMode>("broken")
  // qty per item (default = pending). received SKU per item (Wrong tab only).
  const [qtys, setQtys] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const it of items) m[selKey(it)] = String(it.totalPending)
    return m
  })
  const [received, setReceived] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const byEvent = useMemo(() => {
    const m = new Map<string, ArrivalListItem[]>()
    for (const it of items) {
      const arr = m.get(it.event) ?? []
      arr.push(it)
      m.set(it.event, arr)
    }
    return m
  }, [items])

  const qtyOf = (it: ArrivalListItem) => Math.min(Number(qtys[selKey(it)]) || 0, it.totalPending)
  const activeItems = items.filter((it) => qtyOf(it) > 0)
  const totalQty = activeItems.reduce((s, it) => s + qtyOf(it), 0)
  // Wrong needs a valid received SKU (present, differs from expected) on every active row.
  const wrongMissingSku =
    mode === "wrong" &&
    activeItems.some((it) => {
      const sku = received[selKey(it)]
      return !sku || sku === it.productName
    })
  const canSubmit = totalQty > 0 && !wrongMissingSku

  async function handleSubmit() {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setErrors([])

    const targets = activeItems.map((it) => ({
      key: selKey(it),
      event: it.event,
      productId: it.productId,
      productName: it.productName,
      qty: qtyOf(it),
      receivedItem: received[selKey(it)],
    }))

    const settled = await Promise.allSettled(
      targets.map((t) =>
        fetch("/api/sheets/arrival-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "not_received",
            mode,
            event: t.event,
            productId: t.productId,
            productName: t.productName,
            qty: t.qty,
            ...(mode === "wrong" ? { receivedItem: t.receivedItem } : {}),
          }),
        }).then(async (res) => {
          const data = await res.json()
          if (!res.ok) throw new Error(data.error ?? `Failed for ${t.productName}`)
          return t.key
        }),
      ),
    )

    const succeeded: string[] = []
    const failed: string[] = []
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") succeeded.push(targets[i].key)
      else failed.push(`${targets[i].productName}: ${r.reason instanceof Error ? r.reason.message : "failed"}`)
    })

    setSubmitting(false)
    if (failed.length === 0) onSuccess()
    else { setErrors(failed); if (succeeded.length > 0) onPartial(succeeded) }
  }

  const TABS: [NotReceivedMode, string][] = [
    ["wrong", "Wrong"],
    ["broken", "Broken"],
    ["missing", "Missing"],
    ["cancelled", "Cancelled"],
  ]

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
            Not received — {items.length} item{items.length === 1 ? "" : "s"}
          </h3>
          <p className="text-xs text-muted mt-0.5">
            Records the chosen quantity as not received, refunding the highest-priority orders first. Leftover units stay pending.
          </p>
        </div>

        <div className="px-5 pt-4 shrink-0">
          <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs">
            {TABS.map(([m, label]) => {
              const active = mode === m
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`flex-1 px-2 py-1.5 font-medium transition-colors ${active ? "bg-amber-500 text-white" : "text-muted hover:bg-cream"}`}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="px-5 py-4 overflow-y-auto min-h-0 flex flex-col gap-4">
          {[...byEvent.entries()].map(([event, evItems]) => (
            <div key={event} className="flex flex-col gap-2">
              <div className="text-xs font-semibold text-muted">{event}</div>
              {evItems.map((it) => {
                const k = selKey(it)
                const sku = received[k]
                const skuInvalid = mode === "wrong" && qtyOf(it) > 0 && (!sku || sku === it.productName)
                return (
                  <div key={k} className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-foreground break-words">{it.productName}</div>
                        {it.store && <div className="text-[11px] text-faint">{it.store}</div>}
                      </div>
                      <input
                        type="number"
                        min="0"
                        max={it.totalPending}
                        value={qtys[k] ?? ""}
                        onChange={(e) => setQtys((p) => ({ ...p, [k]: e.target.value }))}
                        className="w-20 shrink-0 border border-cream-border rounded-lg px-2 py-1.5 text-sm text-right bg-white focus:outline-none focus:ring-2 focus:ring-amber-400/40 focus:border-amber-500 transition-colors"
                      />
                      <span className="text-[11px] text-faint w-16 shrink-0">/ {it.totalPending} pending</span>
                    </div>
                    {mode === "wrong" && (
                      <div className="flex flex-col gap-1">
                        <SearchableSelect
                          value={sku ?? ""}
                          onChange={(v) => setReceived((p) => ({ ...p, [k]: v }))}
                          options={itemOptions}
                          placeholder="Received item (what supplier sent)…"
                        />
                        {skuInvalid && <span className="text-[11px] text-red-600">Pick a received item different from the expected one.</span>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-cream-border shrink-0 flex flex-col gap-3">
          {errors.length > 0 && (
            <div className="text-xs text-red-600">
              <div className="font-medium">Some items failed (others were recorded):</div>
              <ul className="list-disc pl-4">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !canSubmit}
              className="px-4 py-1.5 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-50 transition-colors"
            >
              {submitting ? "Saving…" : "Confirm"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
