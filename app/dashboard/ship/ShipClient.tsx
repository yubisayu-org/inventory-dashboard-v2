"use client"

import { displayIg } from "@/lib/format"
import TableSkeleton from "@/components/TableSkeleton"
import SelectionActionBar from "@/components/SelectionActionBar"
import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import type { ShipCustomer, ShipOrdersParams, ShipSegment, ShipStatus, ShipOrdersFiltered, PaymentStatus } from "@/lib/db"
import { normalizeId, parcelPlanExtra } from "@/lib/db/helpers"
import { generateShippingLabel } from "@/lib/shipping-label"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import { useResizableColumns } from "@/hooks/useResizableColumns"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { useMessageTemplates } from "@/hooks/useMessageTemplates"
import { useBusinessProfile } from "@/hooks/useBusinessProfile"
import EventSelect from "@/components/EventSelect"
import SearchInput from "@/components/SearchInput"
import { InvoiceDetailDrawer } from "@/app/dashboard/invoice/InvoiceDetailDrawer"
import { copyToClipboard } from "@/lib/clipboard"
import { buildShipmentConfirmMessage } from "@/lib/shipment-message"

type Segment = ShipSegment

// In the order a packing day is worked: what can go now, then the plans that
// are running, then what is blocked, then what is only waiting, and the
// finished and the whole lot at the end. The tab this opens on is the first
// one for the same reason.
const SEGMENTS: { id: Segment; label: string }[] = [
  { id: "ready", label: "Siap Kirim" },
  { id: "split_requested", label: "Kirim Duluan" },
  { id: "paired", label: "Gabung" },
  { id: "ready_unpaid", label: "Belum Bayar" },
  { id: "hold", label: "Tunda Kirim" },
  { id: "partial", label: "Tiba Sebagian" },
  { id: "not_arrived", label: "Belum Tiba" },
  { id: "shipped", label: "Sudah Dikirim" },
  { id: "all", label: "Semua" },
]

// Per-line hold marker. Icon rather than a "Hold" pill so it doesn't compete
// with the product name for width; title/aria carry the label for hover and
// screen readers.
function HoldIcon() {
  return (
    <svg
      role="img"
      aria-label="Tunda Kirim"
      className="ml-1.5 inline-block align-[-0.15em] text-purple-600 shrink-0"
      width="14" height="14" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    >
      <title>Tunda Kirim</title>
      <circle cx="12" cy="12" r="10" />
      <line x1="10" y1="15" x2="10" y2="9" />
      <line x1="14" y1="15" x2="14" y2="9" />
    </svg>
  )
}

// Card badge styling per arrival/ship status (mirrors SEGMENTS labels).
/**
 * Units that would travel if this card shipped now.
 *
 * Not `toShip`, which is zero on a paired card by design — pairing parks the
 * parcel, and combining is what unparks it. Anything deciding whether a pair
 * can go has to look past its own parking, or the pair waits for itself.
 */
function unparkedToShip(c: ShipCustomer): number {
  return c.status === "paired"
    ? c.orders.reduce((n, o) => n + Math.max(0, o.unitArrive - o.unitShip), 0)
    : c.totalToShip
}

function unparkedOrders(c: ShipCustomer) {
  return c.orders
    .map((o) => ({ ...o, toShip: c.status === "paired" ? Math.max(0, o.unitArrive - o.unitShip) : o.toShip }))
    .filter((o) => o.toShip > 0)
}

const STATUS_BADGE: Record<ShipStatus, { label: string; cls: string }> = {
  not_arrived: { label: "Belum Tiba", cls: "bg-surface-sunken text-muted" },
  partial: { label: "Tiba Sebagian", cls: "bg-amber-100 text-amber-700" },
  ready: { label: "Siap Kirim", cls: "bg-brand/10 text-brand" },
  ready_unpaid: { label: "Belum Bayar", cls: "bg-orange-100 text-orange-700" },
  hold: { label: "Tunda Kirim", cls: "bg-purple-100 text-purple-700" },
  split_requested: { label: "Kirim Duluan", cls: "bg-blue-100 text-blue-700" },
  paired: { label: "Gabung", cls: "bg-blue-100 text-blue-700" },
  shipped: { label: "Sudah Dikirim", cls: "bg-green-100 text-green-700" },
}

// Payment-status chip rendered on every ship card so the new "paid/overpaid"
// criterion is visible at a glance.
const PAYMENT_BADGE: Record<PaymentStatus, { label: string; cls: string }> = {
  paid:     { label: "Lunas",          cls: "bg-green-100 text-green-700" },
  overpaid: { label: "Lebih Bayar",    cls: "bg-blue-100 text-blue-700" },
  partial:  { label: "Bayar Sebagian", cls: "bg-amber-100 text-amber-700" },
  unpaid:   { label: "Belum Bayar",    cls: "bg-rose-100 text-rose-700" },
  void:     { label: "Void",           cls: "bg-surface-sunken text-muted" },
}

export default function ShipClient() {
  const router = useRouter()
  const sheetOptions = useSheetOptions()
  const [groups, setGroups] = useState<ShipCustomer[]>([])
  const [counts, setCounts] = useState<Record<Segment, number>>({ all: 0, not_arrived: 0, partial: 0, split_requested: 0, paired: 0, ready: 0, ready_unpaid: 0, hold: 0, shipped: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [segment, setSegment] = useState<Segment>("ready")
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [eventFilter, setEventFilter] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkShipping, setBulkShipping] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)
  // Gate the bulk-ship action behind a confirmation, mirroring the single-card
  // ShipConfirmModal.
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [invoiceCustomer, setInvoiceCustomer] = useState<string | null>(null)
  const [page, setPage] = useState(0)

  // Debounce search
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(id)
  }, [search])

  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => () => { abortRef.current?.abort() }, [])

  const fetchData = useCallback(async (seg: Segment, srch: string, ev: string) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      params.set("segment", seg)
      if (srch) params.set("search", srch)
      if (ev) params.set("event", ev)

      const res = await fetch(`/api/sheets/ship?${params}`, { signal: ac.signal })
      const json: ShipOrdersFiltered = await res.json()
      if (!res.ok) throw new Error((json as unknown as { error: string }).error ?? "Failed to load")
      setGroups(json.groups)
      setCounts(json.counts)
    } catch (err) {
      if ((err as Error).name === "AbortError") return
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      if (!ac.signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData(segment, debouncedSearch, eventFilter)
  }, [segment, debouncedSearch, eventFilter, fetchData])

  // Client-side simple pagination for the browsing tabs (not the selection tabs).
  const SHIP_PAGE_SIZE = 25
  const PAGINATED_SEGMENTS: Segment[] = ["all", "not_arrived", "partial", "shipped"]
  const paginated = PAGINATED_SEGMENTS.includes(segment)
  const pageCount = paginated ? Math.max(1, Math.ceil(groups.length / SHIP_PAGE_SIZE)) : 1
  const pageGroups = paginated ? groups.slice(page * SHIP_PAGE_SIZE, page * SHIP_PAGE_SIZE + SHIP_PAGE_SIZE) : groups
  useEffect(() => { setPage(0) }, [segment, debouncedSearch, eventFilter, groups.length])

  function refresh() {
    fetchData(segment, debouncedSearch, eventFilter)
  }

  // One card per pair. The server marks the members and hands over the key; the
  // pair's own readiness is decided here, from the same rule the badge counts:
  // every member early means the box goes now, anything else waits for the
  // slowest, and a pair with one of each waits — a shared box has one departure.
  const bundles = (() => {
    const byKey = new Map<string, ShipCustomer[]>()
    for (const g of groups) {
      if (g.status !== "paired" || !g.mergeKey) continue
      const key = `${normalizeId(g.customer)}|${g.mergeKey}`
      const list = byKey.get(key)
      if (list) list.push(g)
      else byKey.set(key, [g])
    }
    return [...byKey.entries()]
      .filter(([, members]) => members.length >= 2)
      .map(([key, members]) => {
        const allSplit = members.every((m) => m.splitRequested)
        const mixed = !allSplit && members.some((m) => m.splitRequested)
        const complete = (m: ShipCustomer) => m.orders.every((o) => o.unitArrive >= o.unit)
        return {
          key,
          members,
          allSplit,
          mixed,
          ready: allSplit ? members.some((m) => unparkedToShip(m) > 0) : members.every(complete),
          waitingFor: members.filter((m) => !complete(m)).map((m) => m.event),
        }
      })
  })()

  const readyFiltered = groups.filter((c) => c.totalToShip > 0)
  const allSelected = readyFiltered.length > 0 && readyFiltered.every((c) => selected.has(`${c.customer}|${c.event}`))

  // Anything with units still to send can be picked, not only what is on the
  // bench today. Pairing two trips that have not arrived at all is the case
  // this exists for most: the boxes are planned together before either lands,
  // and the ongkir is settled on the invoice she has yet to pay.
  const unsentUnits = (c: ShipCustomer) => c.orders.reduce((n, o) => n + (o.unit - o.unitShip), 0)
  const selectable = groups.filter((c) => unsentUnits(c) > 0)

  // Combining is offered whenever the selected cards are all one customer; the
  // modal then fetches that customer's other events to combine.
  const selectedGroups = selectable.filter((c) => selected.has(`${c.customer}|${c.event}`))
  const mergeCustomers = new Set(selectedGroups.map((c) => normalizeId(c.customer)))
  const mergeEligible = selectedGroups.length >= 1 && mergeCustomers.size === 1
  // Shipping, though, still needs something on the bench.
  const selectedShippable = readyFiltered.filter((c) => selected.has(`${c.customer}|${c.event}`))

  function toggleSelect(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleSelectAll() {
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(readyFiltered.map((c) => `${c.customer}|${c.event}`)))
    }
  }

  async function handleBulkShip() {
    const toShip = readyFiltered.filter((c) => selected.has(`${c.customer}|${c.event}`))
    if (toShip.length === 0) return
    setBulkShipping(true)
    setBulkError(null)
    setBulkProgress({ done: 0, total: toShip.length })
    try {
      for (const c of toShip) {
        const params: ShipOrdersParams = {
          customer: c.customer,
          event: c.event,
          orders: c.orders.map((o) => ({
            rowNumber: o.rowNumber,
            productId: o.productId,
            productName: o.productName,
            toShip: o.toShip,
            unitShip: o.unitShip,
          })),
          weightKg: c.weightKg,
          ongkirPerKg: c.ongkirPerKg,
        }
        const res = await fetch("/api/sheets/ship", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error ?? `Failed for ${c.customer}`)
        }
        setBulkProgress((prev) => prev ? { ...prev, done: prev.done + 1 } : null)
      }
      router.push("/dashboard/shipments")
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Terjadi kesalahan")
      setBulkShipping(false)
      setBulkProgress(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Segment control */}
      <div className="flex items-center gap-1 w-full rounded-xl border border-cream-border bg-white p-1 overflow-x-auto">
        {SEGMENTS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => { setSegment(s.id); setSelected(new Set()) }}
            className={`flex-1 shrink-0 flex items-center justify-center gap-1 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              segment === s.id
                ? "bg-brand text-white"
                : "text-muted hover:text-foreground"
            }`}
          >
            {s.label}
            <span
              className={`hidden sm:inline text-xs rounded-full px-1.5 py-0.5 tabular-nums ${
                segment === s.id
                  ? "bg-white/20 text-white"
                  : "bg-surface-sunken text-muted"
              }`}
            >
              {counts[s.id]}
            </span>
          </button>
        ))}
      </div>

      {/* Search + event filter */}
      <div className="flex gap-2 md:flex-wrap">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Cari customer…"
          className="flex-1 min-w-0 md:min-w-[160px]"
        />
        <div className="w-36 md:w-48 shrink-0">
          <EventSelect
            value={eventFilter}
            onChange={setEventFilter}
            events={sheetOptions?.events ?? []}
            placeholder="Semua Event"
            clearable
          />
        </div>
        {/* Desktop select-all toggle (mobile uses the round FAB). Shown on the
            "Siap Dikirim" tab even when empty. */}
        {!loading && !error && segment === "ready" && (
          <button
            type="button"
            onClick={toggleSelectAll}
            disabled={bulkShipping}
            aria-label={allSelected ? "Deselect all" : "Select all"}
            title={allSelected ? "Deselect all" : "Select all"}
            className="hidden md:inline-flex items-center gap-1.5 shrink-0 rounded-lg border border-cream-border h-[38px] px-3 text-sm text-muted-strong bg-white hover:border-brand hover:text-brand transition-colors disabled:opacity-50"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            {allSelected && <span className="w-1.5 h-1.5 rounded-full bg-brand" />}
          </button>
        )}
      </div>

      {/* States */}
      {loading && <TableSkeleton />}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {!loading && !error && groups.length === 0 && (
        <div className="rounded-xl border border-cream-border bg-white p-12 text-center text-faint text-sm">
          Tidak ada pesanan.
        </div>
      )}

      {/* Results */}
      {!loading && !error && groups.length > 0 && (
        <>
          {/* Mobile select-all FAB — round icon button like the Events "+" FAB.
              Only on the "Siap Dikirim" tab, matching desktop. */}
          {segment === "ready" && readyFiltered.length > 0 && (
            <button
              type="button"
              onClick={toggleSelectAll}
              disabled={bulkShipping}
              aria-label={allSelected ? "Deselect all" : "Select all"}
              className="md:hidden fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 w-14 h-14 rounded-full bg-brand text-white shadow-lg flex items-center justify-center active:bg-brand/90 disabled:opacity-50"
            >
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </button>
          )}
          {bulkError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {bulkError}
            </div>
          )}
          {/* Floating action bar (like shopping/receiving) for the selection
              actions — Combine + Ship. Shown on desktop and mobile. */}
          {selected.size > 0 && (
            <div className="contents">
              <SelectionActionBar
                reserveFab={segment === "ready"}
                count={selected.size}
                onClear={() => setSelected(new Set())}
                actions={[
                  ...(mergeEligible
                    ? [{
                        label: "Combine",
                        color: "blue" as const,
                        onClick: () => setMerging(true),
                        disabled: bulkShipping,
                        icon: (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M6 9v6" /><path d="M18 6a9 9 0 0 1-9 9" /><circle cx="18" cy="6" r="3" />
                          </svg>
                        ),
                      }]
                    : []),
                  {
                    label: bulkShipping && bulkProgress ? `${bulkProgress.done}/${bulkProgress.total}` : "Ship",
                    color: "brand" as const,
                    onClick: () => setBulkConfirmOpen(true),
                    // Selecting a card with nothing arrived is now allowed, for
                    // combining. Shipping it is not — there is no box.
                    disabled: bulkShipping || selectedShippable.length === 0,
                    icon: (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" />
                      </svg>
                    ),
                  },
                ]}
              />
            </div>
          )}
          {segment === "paired" && bundles.map((b) => (
            <BundleCard
              key={b.key}
              bundle={b}
              onDone={() => { setSegment("all"); refresh() }}
              onOpenInvoice={() => setInvoiceCustomer(b.members[0].customer)}
            />
          ))}
          {segment !== "paired" && pageGroups.map((c) => {
            const key = `${c.customer}|${c.event}`
            return (
              <CustomerCard
                key={key}
                customer={c}
                segment={segment}
                isSelected={selected.has(key)}
                onToggleSelect={unsentUnits(c) > 0 ? () => toggleSelect(key) : undefined}
                onShipped={() => { setSegment("all"); refresh() }}
                onRefresh={refresh}
                onOpenInvoice={() => setInvoiceCustomer(c.customer)}
              />
            )
          })}
          {paginated && pageCount > 1 && (
            <div className="flex items-center justify-between gap-3 pt-1">
              <button type="button" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm text-muted-strong disabled:opacity-40">Prev</button>
              <span className="text-xs text-faint">Page {page + 1} of {pageCount}</span>
              <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm text-muted-strong disabled:opacity-40">Next</button>
            </div>
          )}
        </>
      )}

      {bulkConfirmOpen && selectedShippable.length > 0 && (
        <BulkShipConfirmModal
          groups={selectedShippable}
          busy={bulkShipping}
          onClose={() => setBulkConfirmOpen(false)}
          onConfirm={() => { setBulkConfirmOpen(false); handleBulkShip() }}
        />
      )}
      {merging && mergeEligible && (
        <MergeShipConfirmModal
          customer={selectedGroups[0].customer}
          preselectedEvents={selectedGroups.map((g) => g.event)}
          onClose={() => setMerging(false)}
          onSuccess={() => { setMerging(false); setSelected(new Set()); setSegment("all"); refresh() }}
        />
      )}
      {invoiceCustomer && (
        <InvoiceDetailDrawer
          customer={invoiceCustomer}
          onClose={() => setInvoiceCustomer(null)}
        />
      )}
    </div>
  )
}

// Build a WhatsApp deep link with the message prefilled. Indonesian numbers are
// normalized to international (0… → 62…, 8… → 62…). Without a number we fall
// back to the send picker so the user can choose a chat. (Same helper as the
// invoice message modal.)
function waLink(whatsapp: string | null | undefined, message: string): string {
  const text = encodeURIComponent(message)
  let num = (whatsapp ?? "").replace(/\D/g, "")
  if (num.startsWith("0")) num = "62" + num.slice(1)
  else if (num.startsWith("8")) num = "62" + num
  return num ? `https://wa.me/${num}?text=${text}` : `https://api.whatsapp.com/send?text=${text}`
}

// One "Product x N x Rp price" line per shipped row — matches the format the
// copy-confirm button and downstream messaging use.
function confirmMessageItems(c: ShipCustomer): string[] {
  return c.orders
    .filter((o) => o.toShip > 0)
    .map((o) => `${o.productName} x ${o.toShip} x Rp ${o.unitPrice.toLocaleString("id-ID")}`)
}

type CopyState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "copied" }
  | { status: "error"; message: string }

function CopyConfirmMessageButton({ customer: c, className }: { customer: ShipCustomer; className?: string }) {
  const [state, setState] = useState<CopyState>({ status: "idle" })
  const templates = useMessageTemplates()
  const businessProfile = useBusinessProfile()

  useEffect(() => {
    if (state.status === "idle") return
    const delay = state.status === "error" ? 3000 : 1500
    const timer = setTimeout(() => setState({ status: "idle" }), delay)
    return () => clearTimeout(timer)
  }, [state.status])

  async function handleClick() {
    setState({ status: "loading" })
    try {
      // Only the rows being shipped this round (toShip > 0). Format mirrors
      // shipments.invoicing: one "Product x N" line per row, not consolidated,
      // so a repeated product reads as two lines (matches downstream messaging).
      const message = buildShipmentConfirmMessage({
        event: c.event,
        customer: c.customer,
        dataDiri: c.customerDetail?.dataDiri ?? "",
        items: confirmMessageItems(c),
      }, templates?.shipment, businessProfile?.publicSiteUrl)
      await copyToClipboard(message)
      setState({ status: "copied" })
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Failed" })
    }
  }

  const { status } = state
  const label =
    status === "loading" ? "…"
    : status === "copied" ? "✓"
    : status === "error" ? "!"
    : undefined

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={status === "loading" || !templates || !businessProfile}
      title={status === "error" ? state.message : "Copy pesan konfirmasi pengiriman"}
      className={`${className ?? "p-1 rounded"} inline-flex items-center justify-center transition-colors disabled:opacity-50 ${
        status === "copied" ? "text-green-600"
        : status === "error" ? "text-red-500"
        : "text-faint hover:text-brand"
      }`}
    >
      {label ? (
        <span className="text-xs font-medium w-3.5 inline-block text-center">{label}</span>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      )}
    </button>
  )
}

function CustomerCard({
  customer: c,
  segment,
  isSelected,
  onToggleSelect,
  onShipped,
  onRefresh,
  onOpenInvoice,
}: {
  customer: ShipCustomer
  segment: Segment
  isSelected?: boolean
  onToggleSelect?: () => void
  onShipped: () => void
  // Reloads without moving you: charging a fee is not a reason to lose your
  // place in the tab you were working through, which onShipped would do.
  onRefresh: () => void
  onOpenInvoice: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [holdBusy, setHoldBusy] = useState(false)
  const [holdError, setHoldError] = useState<string | null>(null)
  const [splitBusy, setSplitBusy] = useState(false)
  const [splitError, setSplitError] = useState<string | null>(null)
  const paymentClear = ["paid", "overpaid", "void"].includes(c.paymentStatus)
  const { customerDetail } = c
  const { widths, startResize } = useResizableColumns({ items: 200, unit: 80, unitArrive: 80, unitShip: 80, toShip: 80 })
  const totalHold = c.orders.reduce((s, o) => s + o.unitHold, 0)
  // Something to send and something still to come. Everything arrived is one
  // parcel whatever anyone declares; nothing arrived is not a split either.
  const totalUnits = c.orders.reduce((s, o) => s + o.unit, 0)
  const totalShipped = c.orders.reduce((s, o) => s + o.unitShip, 0)
  // Something to send and something still to come — and not already declared.
  // Once declared the card sits in Kirim Duluan, where the same button plainly
  // ships, so it must stop offering to declare what it already has.
  const canSplit = !c.splitRequested
    && c.totalToShip > 0 && c.totalToShip + totalShipped < totalUnits

  /**
   * Record what the parcels are going to be. The fee or credit follows on its
   * own — it is not a separate button any more, which is how it used to be
   * forgotten.
   */
  async function postPlan(action: "split" | "unsplit" | "merge" | "unmerge", events: string[]) {
    const cost = c.splitExtraOngkir
    const asking = action === "split" && cost > 0
      ? `Kirim duluan ${displayIg(c.customer).toUpperCase()} · ${c.event}?\n\n`
        + `Ongkir tambahan Rp ${cost.toLocaleString("id-ID")} akan ditambahkan ke tagihannya, `
        + `dan paket baru bisa dikirim setelah dibayar.`
      : action === "unsplit"
        ? `Batalkan kirim duluan untuk ${displayIg(c.customer).toUpperCase()} · ${c.event}?`
        : null
    if (asking && !confirm(asking)) return

    setSplitBusy(true)
    setSplitError(null)
    try {
      const res = await fetch("/api/sheets/ship/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, customer: c.customer, events }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      onRefresh()
    } catch (err) {
      setSplitError(err instanceof Error ? err.message : "Failed")
      setSplitBusy(false)
    }
  }

  async function postHoldAction(path: "hold" | "release", confirmMessage: string) {
    if (!confirm(confirmMessage)) return
    setHoldBusy(true)
    setHoldError(null)
    try {
      const res = await fetch(`/api/sheets/ship/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer: c.customer, event: c.event }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? "Failed")
      }
      onShipped()
    } catch (err) {
      setHoldError(err instanceof Error ? err.message : "Failed")
      setHoldBusy(false)
    }
  }

  return (
    <div className={`rounded-xl border bg-white overflow-hidden transition-colors ${isSelected ? "border-brand" : "border-cream-border"}`}>
      {/* items-center: both sides are a single row now that the ship/hold counts
          live inside their buttons, so the identity line and the buttons should
          sit on the same axis. */}
      <div className="px-5 py-4 bg-surface-muted border-b border-cream-border flex justify-between gap-4 items-center">
        <div className="flex items-center gap-3 min-w-0">
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={isSelected ?? false}
              onChange={onToggleSelect}
              className="rounded border-cream-border text-brand focus:ring-brand/30 cursor-pointer shrink-0"
            />
          )}
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="flex flex-col md:flex-row md:items-center gap-0.5 md:gap-1.5 min-w-0">
              <span className="text-xs font-semibold text-foreground">{c.event}</span>
              <button
                type="button"
                onClick={onOpenInvoice}
                className="text-xs text-muted font-medium hover:text-brand hover:underline cursor-pointer text-left truncate min-w-0"
                title="Lihat invoice"
              >
                {displayIg(c.customer).toUpperCase()}
              </button>
            </span>
            {/* Two reasons to drop the status badge: the "Belum Bayar" tab
                already says it in the tab itself, and anywhere the two chips
                would render the identical label (ready_unpaid + unpaid both
                read "Belum Bayar") it'd just print twice in a row. */}
            {segment !== "ready_unpaid" && STATUS_BADGE[c.status].label !== PAYMENT_BADGE[c.paymentStatus].label && (
              <span className={`hidden md:inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[c.status].cls}`}>
                {STATUS_BADGE[c.status].label}
              </span>
            )}
            <span className={`hidden md:inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${PAYMENT_BADGE[c.paymentStatus].cls}`}>
              {PAYMENT_BADGE[c.paymentStatus].label}
            </span>
            {/* Surfaces a hold on a card whose status badge is something else
                (e.g. "Tiba Sebagian") — the "hold" status only wins once every
                line has arrived, so without this a held unit on a partial event
                would show no sign it's being held back. */}
            {/* Visible on the card, not only inside the modal: a redirected
                parcel that is only discoverable by opening the ship dialog is
                one bulk print away from going to the wrong house. */}
            {c.requestedAddress && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">
                Alamat lain diminta
              </span>
            )}
            {totalHold > 0 && c.status !== "hold" && (
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE.hold.cls}`}>
                {STATUS_BADGE.hold.label}
              </span>
            )}
          </div>
        </div>
        </div>
        {/* Ship and hold are independent: a partially-arrived card can have some
            ready units AND some held units at once, so each sub-block renders on
            its own condition. Release is keyed on totalHold (not status === "hold")
            so a hold on a "Tiba Sebagian" card is still releasable — otherwise a
            held unit whose siblings haven't arrived would be stranded with no
            checkbox, Ship, or Release control. */}
        {/* The declared split says nothing here any more. What it costs and
            whether it is settled both live on the Ship button — the control
            that acts on them — so the card keeps its shape whether or not a
            split is running. */}
        {/* No merge control here. Combining is one route — select the cards
            and use Combine — and it now covers both cases: everything ready
            ships as one box, anything still waiting is recorded and priced and
            travels together later. A second way in from the card was the same
            act under another name. */}
        {splitError && (
          <div className="px-5 py-2 text-xs text-red-700 bg-red-50 border-b border-cream-border">{splitError}</div>
        )}
        {/* A running split keeps its controls with an empty bench: its early box
            has gone, a fee is charged, and the remainder is still owed. The
            card is being tracked, not acted on, and Ship says so by being
            greyed rather than absent. */}
        {(c.totalToShip > 0 || totalHold > 0 || c.splitRequested) && (
          <div className="shrink-0 flex items-center gap-3">
            {(c.totalToShip > 0 || c.splitRequested) && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {c.totalToShip > 0 && (
                    <CopyConfirmMessageButton customer={c} className="px-3 py-1.5 rounded-lg border border-cream-border hover:bg-surface-muted" />
                  )}
                  <button
                    type="button"
                    onClick={() => postHoldAction("hold", `Hold this packing list for ${displayIg(c.customer).toUpperCase()} · ${c.event}?`)}
                    disabled={holdBusy}
                    className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-xs font-medium hover:bg-surface-muted disabled:opacity-50 transition-colors"
                  >
                    {holdBusy ? "…" : "Hold"}
                  </button>
                  {/* Between Hold and Ship, because that is the order the card
                      is worked in: park it, undo the split, or send it.

                      Only while the box is still here. Once the early parcel
                      has gone the split is not a plan any more, it is
                      something that happened — there is nothing left to
                      cancel, and a button offering to would be offering to
                      unpick a journey. */}
                  {c.splitRequested && totalShipped === 0 && (
                    <button
                      type="button"
                      onClick={() => postPlan("unsplit", [c.event])}
                      disabled={splitBusy}
                      title="Batalkan kirim duluan — ongkir tambahannya ikut dihapus"
                      className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-xs font-medium hover:bg-surface-muted disabled:opacity-50 transition-colors"
                    >
                      {splitBusy ? "…" : "Cancel Split"}
                    </button>
                  )}
                  {/* Two acts, two names, two places. Sending part of an order
                      is a decision — it commits the shop to a second trip to
                      the courier and, where the rounding does not absorb it,
                      the customer to a second fee. So the partly-arrived card
                      declares it, and the card moves to Kirim Duluan where a
                      plain Ship sends it.

                      One button doing both, changing meaning by context, is
                      what this replaced. */}
                  <button
                    type="button"
                    onClick={() => (canSplit ? postPlan("split", [c.event]) : setConfirming(true))}
                    // A declared split whose fee is unpaid holds the parcel.
                    // That is the whole order of events the shop asked for:
                    // she settles the extra ongkir, then the box goes.
                    disabled={holdBusy || splitBusy || c.totalToShip === 0
                      || (c.splitRequested && !paymentClear)}
                    // What it costs, on the control that does it. A strip
                    // saying the same thing an inch away made the card busy
                    // for a fact most cards do not have to act on.
                    title={
                      c.totalToShip === 0
                        ? "Menunggu sisanya tiba — kotak pertama sudah berangkat"
                        : c.splitRequested
                        ? c.splitExtraOngkir > 0
                          ? `Ongkir tambahan Rp ${c.splitExtraOngkir.toLocaleString("id-ID")} — `
                            + (paymentClear ? "lunas, siap dikirim" : "menunggu pembayaran")
                          : "Tidak ada ongkir tambahan — pembulatan berat menutupinya"
                        : canSplit
                          ? c.splitExtraOngkir > 0
                            ? `Kirim ${c.totalToShip} unit sekarang, sisanya menyusul — `
                              + `ongkir tambahan Rp ${c.splitExtraOngkir.toLocaleString("id-ID")}, `
                              + "dibayar sebelum paket berangkat"
                            : `Kirim ${c.totalToShip} unit sekarang, sisanya menyusul — `
                              + "tidak menambah ongkir, pembulatan berat menutupinya"
                          : undefined
                    }
                    className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                  >
                    {splitBusy ? "…" : canSplit ? "Split Ship" : "Ship"}
                    {/* Count lives in the button instead of a stacked
                        "N / to ship" block below it — that block forced every
                        card header to be three rows tall, leaving a big empty
                        gap next to short item lists. */}
                    <span className="px-1.5 py-0.5 rounded bg-white/20 tabular-nums font-semibold">{c.totalToShip}</span>
                  </button>
                </div>
              </div>
            )}
            {totalHold > 0 && (
              <div className="flex flex-col items-end gap-1">
                <button
                  type="button"
                  onClick={() => postHoldAction("release", `Release this packing list for ${displayIg(c.customer).toUpperCase()} · ${c.event} back to ready?`)}
                  disabled={holdBusy}
                  className="px-3 py-1.5 rounded-lg bg-green-600 text-white text-xs font-medium hover:bg-green-700 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                >
                  {holdBusy ? "…" : "Release"}
                  {/* Held count sits in the button for the same reason the ship
                      count does — the stacked "N / on hold" block above it made
                      the card header three rows tall. */}
                  {!holdBusy && <span className="px-1.5 py-0.5 rounded bg-white/20 tabular-nums font-semibold">{totalHold}</span>}
                </button>
              </div>
            )}
          </div>
        )}
        {confirming && (
          <ShipConfirmModal
            customer={c}
            onClose={() => setConfirming(false)}
            onSuccess={() => { setConfirming(false); onShipped() }}
          />
        )}
      </div>
      {holdError && (
        <div className="px-5 py-2 text-xs text-red-700 bg-red-50 border-b border-cream-border">{holdError}</div>
      )}

      {/* Orders table (desktop) */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
          <thead>
            <tr className="text-left text-xs text-muted border-b border-cream-border bg-surface-muted/80">
              <th className="px-4 py-2 font-medium relative select-none" style={{ width: widths.items }}>
                Item
                <div onMouseDown={(e) => startResize("items", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.unit }}>
                Ordered
                <div onMouseDown={(e) => startResize("unit", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.unitArrive }}>
                Arrive
                <div onMouseDown={(e) => startResize("unitArrive", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.unitShip }}>
                Shipped
                <div onMouseDown={(e) => startResize("unitShip", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.toShip }}>
                To Ship
                <div onMouseDown={(e) => startResize("toShip", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
            </tr>
          </thead>
          <tbody>
            {c.orders.map((o) => (
              <tr key={o.rowNumber} className="border-b border-cream-border">
                <td className="px-4 py-2">
                  {o.productName}
                  {o.unitHold > 0 && <HoldIcon />}
                </td>
                <td className="px-4 py-2 text-right">{o.unit}</td>
                <td className="px-4 py-2 text-right">{o.unitArrive}</td>
                <td className="px-4 py-2 text-right">{o.unitShip}</td>
                <td className={`px-4 py-2 text-right font-semibold ${o.toShip > 0 ? "text-brand" : "text-faint"}`}>
                  {o.toShip}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Orders list (mobile) */}
      <div className="md:hidden flex flex-col divide-y divide-cream-border/60">
        {c.orders.map((o) => (
          <div key={o.rowNumber} className="px-5 py-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-foreground truncate">
                {o.productName}
                {o.unitHold > 0 && <HoldIcon />}
              </div>
              <div className="text-xs text-faint tabular-nums mt-0.5">
                Order {o.unit} · Tiba {o.unitArrive} · Kirim {o.unitShip}
              </div>
            </div>
            <div className={`shrink-0 text-xs font-semibold tabular-nums ${o.toShip > 0 ? "text-brand" : "text-faint"}`}>
              {o.toShip}
            </div>
          </div>
        ))}
      </div>

      {/* Collapsible address */}
      {customerDetail?.dataDiri && (
        <div className="border-t border-cream-border">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-3 text-xs text-muted hover:text-brand transition-colors"
          >
            <span className="font-medium">Alamat pengiriman</span>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`transition-transform ${expanded ? "rotate-180" : ""}`}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {expanded && (
            <div className="px-5 pb-4">
              <pre className="whitespace-pre-wrap font-sans text-sm text-foreground leading-relaxed">
                {customerDetail.dataDiri}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Confirmation gate for bulk shipping — lists the selected packages and asks
// before firing handleBulkShip (mirrors the single-card ShipConfirmModal's
// "confirm first" behaviour, minus the per-package label preview).
function BulkShipConfirmModal({
  groups,
  busy,
  onConfirm,
  onClose,
}: {
  groups: ShipCustomer[]
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  useModalDismiss(onClose)
  const total = groups.length
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center md:px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-t-xl md:rounded-xl border-x border-t border-cream-border md:border shadow-xl w-full max-w-md flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-cream-border shrink-0">
          <h3 className="text-base md:text-sm font-semibold text-foreground">Konfirmasi Pengiriman</h3>
          <p className="text-xs text-muted mt-0.5">Kirim {total} paket sekaligus?</p>
        </div>
        <div className="px-5 py-4 overflow-y-auto flex flex-col gap-1.5">
          {groups.map((c) => (
            <div key={`${c.customer}|${c.event}`} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                <span className="font-medium text-foreground uppercase">{displayIg(c.customer)}</span>
                <span className="text-faint"> · {c.event}</span>
              </span>
              <span className="tabular-nums text-muted shrink-0">{c.totalToShip}</span>
            </div>
          ))}
        </div>
        <div className="px-5 pt-3 pb-8 md:py-3 border-t border-cream-border shrink-0 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-lg border border-cream-border text-muted-strong text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {busy ? "Mengirim…" : `Kirim ${total} Paket`}
          </button>
        </div>
      </div>
    </div>
  )
}

function ShipConfirmModal({
  customer: c,
  onClose,
  onSuccess,
}: {
  customer: ShipCustomer
  onClose: () => void
  onSuccess: () => void
}) {
  const [shipping, setShipping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ pdfUrl: string; shippingId: string } | null>(null)
  // Optional one-time address override. Toggle off (the default) ships to the
  // customer's profile data_diri. Toggle on reveals an editable textarea pre-
  // filled with that same address so admin can tweak just the parts that
  // differ (receiver name, street) without retyping the whole block.
  // A one-off address the customer asked for on this event beats both: the
  // override starts on, filled with hers. Leaving it off would print her
  // profile address on the label while her own order card says the parcel was
  // redirected — and nobody finds out until it arrives at the wrong house.
  const profileAddress = c.customerDetail?.dataDiri ?? ""
  const requestedAddress = c.requestedAddress
  const [useTempAddress, setUseTempAddress] = useState(Boolean(requestedAddress))
  const [tempAddress, setTempAddress] = useState(requestedAddress ?? profileAddress)
  const [msgCopied, setMsgCopied] = useState(false)
  const [pairedWarning, setPairedWarning] = useState<string[] | null>(null)
  const toShipRows = c.orders.filter((o) => o.toShip > 0)
  const templates = useMessageTemplates()
  const businessProfile = useBusinessProfile()

  // Confirmation message uses whichever address is active (temp override or the
  // customer's profile), so Copy / WhatsApp always match what's shown above.
  const confirmMessage = buildShipmentConfirmMessage({
    event: c.event,
    customer: c.customer,
    dataDiri: useTempAddress ? tempAddress : profileAddress,
    items: confirmMessageItems(c),
  }, templates?.shipment, businessProfile?.publicSiteUrl)

  async function handleCopyMessage() {
    try {
      await copyToClipboard(confirmMessage)
      setMsgCopied(true)
      setTimeout(() => setMsgCopied(false), 1500)
    } catch {
      /* clipboard blocked — no-op, WhatsApp button still works */
    }
  }

  const dismissRef = useRef<() => void>(onClose)
  dismissRef.current = result ? onSuccess : onClose
  useModalDismiss(() => dismissRef.current())

  const urlRef = useRef<string | null>(null)
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current) }, [])

  async function handleConfirm(force = false) {
    setShipping(true)
    setError(null)
    setPairedWarning(null)
    const effectiveAddress = useTempAddress ? tempAddress : profileAddress
    const params: ShipOrdersParams = {
      force,
      customer: c.customer,
      event: c.event,
      orders: c.orders.map((o) => ({
        rowNumber: o.rowNumber,
        productId: o.productId,
        productName: o.productName,
        toShip: o.toShip,
        unitShip: o.unitShip,
      })),
      weightKg: c.weightKg,
      ongkirPerKg: c.ongkirPerKg,
      tempAddress: useTempAddress ? tempAddress : null,
    }
    try {
      const res = await fetch("/api/sheets/ship", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      })
      const data = await res.json()
      if (res.status === 409 && data.paired) {
        setPairedWarning(data.partners ?? [])
        setShipping(false)
        return
      }
      if (!res.ok) throw new Error(data.error ?? "Failed")

      const blob = await generateShippingLabel({
        event: c.event,
        customer: c.customer,
        shippingId: data.shippingId,
        dataDiri: effectiveAddress,
        packingLines: toShipRows.map((o) => `${o.productName} x ${o.toShip}`),
      })
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      setResult({ pdfUrl: url, shippingId: data.shippingId })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to ship")
      setShipping(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={() => dismissRef.current()}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-lg flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {pairedWarning && (
          <div className="px-5 py-3 bg-blue-50 border-b border-cream-border text-xs text-blue-900 flex flex-col gap-2">
            <span>
              Customer minta {c.event} digabung dengan <b>{pairedWarning.join(", ")}</b> dalam satu kotak.
              Kirim sendiri saja? Dia akan bayar dua ongkir, dan pasangannya ikut batal.
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPairedWarning(null)}
                className="px-3 py-1.5 rounded-lg border border-cream-border bg-white text-xs font-medium text-muted-strong"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => handleConfirm(true)}
                className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium"
              >
                Kirim sendiri
              </button>
            </div>
          </div>
        )}
        <div className="px-5 py-4 border-b border-cream-border shrink-0">
          <div className="text-sm font-semibold text-foreground">
            {result ? "Label Pengiriman" : "Konfirmasi Pengiriman"}
          </div>
          <div className="text-xs text-muted mt-0.5">
            {displayIg(c.customer).toUpperCase()} · {c.event}
            {result && <span className="ml-2 font-mono">#{result.shippingId}</span>}
          </div>
        </div>

        {result ? (
          <iframe
            src={result.pdfUrl}
            title="Label Pengiriman"
            className="flex-1 w-full border-0 min-h-0"
          />
        ) : (
          <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto">
            <div>
              <div className="text-xs font-medium text-muted mb-2">Item yang dikirim</div>
              <div className="flex flex-col gap-1">
                {toShipRows.map((o) => (
                  <div key={o.rowNumber} className="text-sm text-foreground">{o.items}</div>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs font-medium text-muted">
                  Alamat pengiriman
                  {useTempAddress && (
                    <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-purple-100 text-purple-700">
                      {requestedAddress && tempAddress === requestedAddress ? "Customer Request" : "Sementara"}
                    </span>
                  )}
                </div>
                <label className="inline-flex items-center gap-1.5 text-xs text-muted-strong cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useTempAddress}
                    onChange={(e) => setUseTempAddress(e.target.checked)}
                    className="rounded border-cream-border text-brand focus:ring-brand/30 cursor-pointer"
                  />
                  Kirim ke alamat berbeda
                </label>
              </div>
              {useTempAddress ? (
                <>
                  <textarea
                    value={tempAddress}
                    onChange={(e) => setTempAddress(e.target.value)}
                    rows={5}
                    placeholder={"Nama Penerima\nAlamat lengkap\nNo. telepon"}
                    className="w-full border border-purple-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-500 transition-colors resize-none"
                  />
                  <p className="text-[11px] text-faint mt-1">
                    {requestedAddress && tempAddress === requestedAddress
                      ? "Customer sendiri yang minta alamat ini untuk pesanan ini. Alamat utamanya tidak berubah."
                      : "Alamat ini hanya untuk pengiriman ini. Alamat utama customer tidak berubah."}
                  </p>
                  {c.requestedOtherArea && tempAddress === requestedAddress && (
                    <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mt-1">
                      Area-nya beda dari alamat utama. Ongkir yang tertagih masih pakai tarif area lamanya —
                      cek dulu kalau selisihnya besar.
                    </p>
                  )}
                </>
              ) : (
                profileAddress ? (
                  <pre className="whitespace-pre-wrap font-sans text-sm text-foreground leading-relaxed">
                    {profileAddress}
                  </pre>
                ) : (
                  <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                    Customer belum punya alamat di profil. Aktifkan toggle untuk isi alamat manual.
                  </p>
                )
              )}
            </div>

            <div className="rounded-lg bg-cream/50 px-4 py-3 flex flex-col gap-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted">Estimasi berat</span>
                <span className="font-medium">{c.weightKg} kg</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Ongkir/kg</span>
                <span className="font-medium">Rp {c.ongkirPerKg.toLocaleString("id-ID")}</span>
              </div>
              <div className="flex justify-between border-t border-cream-border mt-1 pt-1">
                <span className="text-muted">Total ongkir</span>
                <span className="font-semibold">Rp {(c.weightKg * c.ongkirPerKg).toLocaleString("id-ID")}</span>
              </div>
            </div>

            {error && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
          </div>
        )}

        <div className="px-5 py-3 border-t border-cream-border flex justify-end gap-2 shrink-0">
          {result ? (
            <>
              <a
                href={result.pdfUrl}
                download={`label-${result.shippingId}.pdf`}
                className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-xs font-medium hover:border-brand hover:text-brand transition-colors"
              >
                Download PDF
              </a>
              <button
                type="button"
                onClick={onSuccess}
                className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
              >
                Tutup
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleCopyMessage}
                disabled={!templates || !businessProfile}
                title="Salin pesan konfirmasi pengiriman"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-xs font-medium hover:border-brand hover:text-brand transition-colors disabled:opacity-50"
              >
                {msgCopied ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                )}
                {msgCopied ? "Tersalin" : "Salin pesan"}
              </button>
              <a
                href={waLink(c.customerDetail?.whatsapp, confirmMessage)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => { if (!templates || !businessProfile) e.preventDefault() }}
                title="Kirim pesan via WhatsApp"
                className={`mr-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-green-500 text-green-700 text-xs font-medium hover:bg-green-500 hover:text-white transition-colors ${templates && businessProfile ? "" : "opacity-50 pointer-events-none"}`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M17.5 14.4c-.3-.15-1.77-.87-2.04-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51-.17-.01-.37-.01-.57-.01-.2 0-.52.07-.8.37-.27.3-1.05 1.02-1.05 2.5s1.07 2.9 1.22 3.1c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.7.62.71.23 1.36.2 1.87.12.57-.08 1.77-.72 2.02-1.42.25-.7.25-1.3.17-1.42-.07-.12-.27-.2-.57-.35zM12.05 21.5h-.01a9.4 9.4 0 0 1-4.8-1.32l-.34-.2-3.57.94.95-3.48-.22-.36a9.42 9.42 0 0 1-1.44-5.02c0-5.2 4.24-9.44 9.45-9.44 2.52 0 4.89.98 6.67 2.77a9.38 9.38 0 0 1 2.76 6.68c0 5.2-4.24 9.44-9.45 9.44zm8.04-17.49A11.36 11.36 0 0 0 12.05.5C5.8.5.72 5.58.72 11.83c0 2 .52 3.95 1.51 5.67L.63 23.5l6.14-1.61a11.33 11.33 0 0 0 5.28 1.34h.01c6.25 0 11.33-5.08 11.33-11.33 0-3.03-1.18-5.87-3.32-8.01z" />
                </svg>
                WhatsApp
              </a>
              <button
                type="button"
                onClick={onClose}
                disabled={shipping}
                className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-xs font-medium hover:border-brand hover:text-brand transition-colors disabled:opacity-50"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => handleConfirm()}
                disabled={shipping}
                className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors disabled:opacity-50"
              >
                {shipping ? "Mengirim…" : "Konfirmasi Kirim"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * One paired group, as one card.
 *
 * The pair is the unit of work here — its members appear in this tab and
 * nowhere else, because two places for one card is two chances to ship it
 * twice. Combining releases the parking the pairing put on, so there is no
 * Release step to remember: the button that fulfils the wish is the door.
 */
function BundleCard({
  bundle: b,
  onDone,
  onOpenInvoice,
}: {
  bundle: {
    key: string
    members: ShipCustomer[]
    allSplit: boolean
    mixed: boolean
    ready: boolean
    waitingFor: string[]
  }
  onDone: () => void
  onOpenInvoice: () => void
}) {
  const [merging, setMerging] = useState(false)
  const [charging, setCharging] = useState(false)
  const [chargeError, setChargeError] = useState<string | null>(null)
  const customer = b.members[0].customer
  const units = b.members.reduce((n, m) => n + unparkedToShip(m), 0)
  const combinedKg = Math.ceil(
    b.members.reduce((g, m) => g + unparkedOrders(m).reduce((a, o) => a + o.gram * o.toShip, 0), 0) / 1000,
  )
  const ongkirPerKg = b.members[0].ongkirPerKg
  // What combining saves: ongkir billed per event, each rounded up, against the
  // whole thing rounded once. The same sum shipMergedCustomerOrders writes as
  // the "Gabung ongkir" adjustment.
  const apart = b.members.reduce(
    (n, m) => n + ongkirPerKg * Math.ceil(m.orders.reduce((g, o) => g + o.gram * o.unit, 0) / 1000),
    0,
  )
  const together =
    ongkirPerKg *
    Math.ceil(b.members.reduce((g, m) => g + m.orders.reduce((a, o) => a + o.gram * o.unit, 0), 0) / 1000)
  const saving = Math.max(0, apart - together)
  const unpaid = b.members.filter((m) => !["paid", "overpaid", "void"].includes(m.paymentStatus))

  // The whole plan, priced once: this box now, one remainder later, against
  // what both invoices already bill. Positive means she owes the difference
  // before it goes; negative is the saving combining gives her, and that one
  // is applied at ship time as it always was.
  const planExtra = parcelPlanExtra(
    b.members.map((m) => ({
      lines: m.orders.map((o) => ({
        gram: o.gram,
        unit: o.unit,
        toShip: Math.max(0, o.unitArrive - o.unitShip),
      })),
    })),
    ongkirPerKg,
  )
  const charged = b.members.some((m) => m.splitCharged)
  const owesForEarly = planExtra > 0 && !charged

  /** Take the group apart. Each trip is priced as its own parcel again. */
  async function unmergePlan() {
    if (!confirm(
      `Batalkan gabung ${b.members.map((m) => m.event).join(" + ")} untuk ${displayIg(customer).toUpperCase()}?\n\n`
      + `Ongkir akan dihitung per paket lagi.`,
    )) return
    setCharging(true)
    setChargeError(null)
    try {
      const res = await fetch("/api/sheets/ship/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "unmerge",
          customer,
          events: b.members.map((m) => m.event),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      onDone()
    } catch (err) {
      setChargeError(err instanceof Error ? err.message : "Failed")
      setCharging(false)
    }
  }

  return (
    <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
      {/* The same header every other card has: what it is on the left, what
          you can do to it on the right. It used to say "diminta customer",
          which stopped being true the day staff could arrange a merge. */}
      <div className="px-5 py-4 bg-surface-muted border-b border-cream-border flex justify-between gap-4 items-center flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm">{b.members.map((m) => m.event).join(" + ")}</span>
          <button type="button" onClick={onOpenInvoice} className="text-sm text-faint uppercase hover:text-brand transition-colors">
            {displayIg(customer)}
          </button>
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
            b.ready ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
          }`}>
            {b.ready ? "Siap Gabung" : "Menunggu"}
          </span>
          {b.allSplit && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
              Kirim duluan — satu kotak
            </span>
          )}
          {b.mixed && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
              Timing beda — kotak menunggu
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {/* Cancel Merge sits where Cancel Split does on a split card: after
              the way out, before the way on. */}
          <button
            type="button"
            onClick={unmergePlan}
            disabled={charging}
            title="Batalkan gabung — ongkirnya dihitung per paket lagi"
            className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-xs font-medium hover:bg-surface-muted disabled:opacity-50 transition-colors"
          >
            {charging ? "…" : "Cancel Merge"}
          </button>
          <button
            type="button"
            onClick={() => setMerging(true)}
            disabled={!b.ready || unpaid.length > 0 || units === 0 || owesForEarly}
            // Why it is greyed comes first: a header badge listing five trip
            // codes explains a disabled button from an inch away, and the
            // header is where you look to identify the card, not to find out
            // why you cannot press something.
            title={
              unpaid.length > 0
                ? `Menunggu pembayaran — ${unpaid.map((m) => m.event).join(", ")}`
                : !b.ready
                  ? `Menunggu ${b.waitingFor.join(", ")} tiba`
                  : planExtra > 0
                    ? `Ongkir tambahan Rp ${planExtra.toLocaleString("id-ID")} untuk seluruh rencana`
                    : planExtra < 0
                      ? `Hemat ongkir Rp ${(-planExtra).toLocaleString("id-ID")} — satu kotak, bukan dua`
                      : "Tidak ada selisih ongkir — pembulatan berat menutupinya"
            }
            className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
          >
            Ship
            <span className="px-1.5 py-0.5 rounded bg-white/20 tabular-nums font-semibold">{units}</span>
          </button>
        </div>
      </div>

      {/* No cost strip. What the plan costs is on the Ship button that acts
          on it, and whether it is paid is a badge in the header — the same
          places every other card keeps them. */}
      {chargeError && (
        <div className="px-5 py-2 text-xs text-red-700 bg-red-50 border-b border-cream-border">{chargeError}</div>
      )}
      {b.members.map((m) => {
        const arrived = m.orders.reduce((n, o) => n + Math.min(o.unitArrive, o.unit), 0)
        const ordered = m.orders.reduce((n, o) => n + o.unit, 0)
        return (
          <div key={m.event} className="px-5 py-3 border-b border-cream-border last:border-b-0">
            <div className="flex items-baseline gap-3 flex-wrap mb-1">
              <span className="text-sm font-medium">{m.event}</span>
              <span className={`text-xs ${arrived >= ordered ? "text-faint" : "text-amber-700 font-medium"}`}>
                {arrived} dari {ordered} tiba
                {arrived < ordered && ` · ${ordered - arrived} masih jalan`}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              {m.orders.map((o) => (
                <div key={o.rowNumber} className={`flex gap-3 text-sm ${o.unitArrive >= o.unit ? "text-muted-strong" : "text-faint"}`}>
                  <span className="flex-1 min-w-0 truncate">{o.productName}</span>
                  <span className="tabular-nums text-xs text-muted">
                    {o.unitArrive}/{o.unit}
                    {Math.max(0, o.unitArrive - o.unitShip) > 0 && ` · kirim ${Math.max(0, o.unitArrive - o.unitShip)}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )
      })}

      <div className="px-5 py-3 bg-surface-muted border-t border-cream-border flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-xs text-muted-strong">
          {b.ready
            ? <>1 kotak · <b className="tabular-nums text-foreground">{units} unit</b> · est. {combinedKg} kg{b.allSplit && " · sisanya menyusul"}</>
            : b.mixed
              ? <>{b.members.filter((m) => m.splitRequested).map((m) => m.event).join(", ")} minta kirim duluan, pasangannya tunggu lengkap</>
              : <>menunggu {b.waitingFor.join(", ")}</>}
        </span>
        {b.ready && saving > 0 && planExtra <= 0 && (
          <span className="text-xs font-medium text-green-700">hemat ongkir Rp {saving.toLocaleString("id-ID")}</span>
        )}
        {b.ready && planExtra > 0 && (
          <span className="text-xs text-muted">sisanya menyusul dalam satu kotak, tanpa ongkir lagi</span>
        )}
      </div>

      {merging && (
        <MergeShipConfirmModal
          customer={customer}
          preselectedEvents={b.members.map((m) => m.event)}
          onClose={() => setMerging(false)}
          onSuccess={() => { setMerging(false); onDone() }}
        />
      )}
    </div>
  )
}

// "Ship together": merge one customer's ready orders across several events into
// a single package — combined weight, ongkir billed once, one label. The modal
// fetches every shippable event for the customer (across all tabs) so you can
// pick which ones to combine without hunting for cards.
function MergeShipConfirmModal({
  customer,
  preselectedEvents,
  onClose,
  onSuccess,
}: {
  customer: string
  preselectedEvents: string[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [allGroups, setAllGroups] = useState<ShipCustomer[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set(preselectedEvents))
  const [shipping, setShipping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ pdfUrl: string; shippingId: string; discount: number } | null>(null)
  // One-time address override for the combined package. Pre-fills with the
  // customer's profile address once it loads so admin can tweak just the
  // parts that differ. One address per box — merged shipments share it.
  const [useTempAddress, setUseTempAddress] = useState(false)
  const [tempAddress, setTempAddress] = useState("")
  const [addressFromCustomer, setAddressFromCustomer] = useState(false)

  // Pull every shippable event for this customer, regardless of which tab the
  // cards live on, so partial + ready events can be combined freely.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/sheets/ship?segment=all&search=${encodeURIComponent(customer)}`)
        const json: ShipOrdersFiltered = await res.json()
        if (!res.ok) throw new Error((json as unknown as { error: string }).error ?? "Failed to load")
        if (cancelled) return
        const mine = json.groups
          // A paired event has toShip 0 until the merge releases it, and it is
          // exactly the event this modal exists to ship. A trip with nothing
          // arrived yet has toShip 0 too, and is exactly what "wait and travel
          // together" means — so both are offered, and what can be picked
          // decides whether the box goes now or waits.
          .filter((g) => normalizeId(g.customer) === normalizeId(customer)
            && (unparkedToShip(g) > 0 || g.orders.some((o) => o.unit > o.unitShip)))
          .sort((a, b) => a.event.localeCompare(b.event))
        setAllGroups(mine)
        setChecked((prev) => {
          const valid = new Set([...prev].filter((e) => mine.some((g) => g.event === e)))
          return valid.size > 0 ? valid : new Set(mine.map((g) => g.event))
        })
      } catch (err) {
        if (!cancelled) setLoadErr(err instanceof Error ? err.message : "Failed to load")
      }
    })()
    return () => { cancelled = true }
  }, [customer])

  const checkedGroups = (allGroups ?? []).filter((g) => checked.has(g.event))
  // Everything picked has stock on the bench → one box, now. Anything still
  // waiting → record that they travel together and let the ongkir follow; the
  // box goes when the last of it lands.
  const shipsNow = checkedGroups.length > 0 && checkedGroups.every((g) => unparkedToShip(g) > 0)
  const customerDetail = allGroups?.[0]?.customerDetail ?? null
  const ongkirPerKg = allGroups?.[0]?.ongkirPerKg ?? 0
  const profileAddress = customerDetail?.dataDiri ?? ""
  // One box, one address — so if any event in it was redirected, that is the
  // address the box goes to. Two different requests in one box is a question
  // for the customer, not something to resolve silently: both are shown.
  const requestedAddresses = Array.from(
    new Set(checkedGroups.map((g) => g.requestedAddress).filter((a): a is string => Boolean(a))),
  )
  const requestedAddress = requestedAddresses[0] ?? null

  // Seed the temp-address textarea once the fetch completes: what the customer
  // asked for if she asked, her profile address otherwise. Only seeds when
  // empty so admin's typing isn't blown away by a re-render.
  useEffect(() => {
    const seed = requestedAddress || profileAddress
    if (seed && !tempAddress) {
      setTempAddress(seed)
      if (requestedAddress) {
        setUseTempAddress(true)
        setAddressFromCustomer(true)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileAddress, requestedAddress])
  const totalGram = checkedGroups.reduce((s, g) => s + unparkedOrders(g).reduce((a, o) => a + o.gram * o.toShip, 0), 0)
  const combinedKg = Math.ceil(totalGram / 1000)
  const combinedOngkir = ongkirPerKg * combinedKg
  const canConfirm = checkedGroups.length >= 2

  function toggle(ev: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(ev)) next.delete(ev)
      else next.add(ev)
      return next
    })
  }

  const dismissRef = useRef<() => void>(onClose)
  dismissRef.current = result ? onSuccess : onClose
  useModalDismiss(() => dismissRef.current())

  const urlRef = useRef<string | null>(null)
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current) }, [])

  async function handleConfirm() {
    if (!canConfirm) return
    setShipping(true)
    setError(null)
    const effectiveAddress = useTempAddress ? tempAddress : profileAddress
    try {
      // Recorded either way, and before anything ships: the pairing is what
      // prices the ongkir as one parcel, and a box that leaves without it
      // would be billed as two.
      const planRes = await fetch("/api/sheets/ship/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "merge", customer, events: checkedGroups.map((g) => g.event),
        }),
      })
      if (!planRes.ok) {
        const d = await planRes.json()
        throw new Error(d.error ?? "Gagal mencatat gabungan")
      }
      if (!shipsNow) {
        // Nothing to send yet. The pairing holds them together and the ongkir
        // is already settled on her invoice.
        onSuccess()
        return
      }

      const res = await fetch("/api/sheets/ship", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer,
          ongkirPerKg,
          groups: checkedGroups.map((g) => ({
            event: g.event,
            orders: unparkedOrders(g)
              .map((o) => ({ rowNumber: o.rowNumber, productName: o.productName, toShip: o.toShip, gram: o.gram })),
          })),
          tempAddress: useTempAddress ? tempAddress : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")

      const packingLines: string[] = []
      for (const g of checkedGroups) {
        for (const o of unparkedOrders(g)) {
          packingLines.push(`[${g.event}] ${o.productName} x ${o.toShip}`)
        }
      }
      const blob = await generateShippingLabel({
        event: checkedGroups.map((g) => g.event).join(" + "),
        customer,
        shippingId: data.shippingId,
        dataDiri: effectiveAddress,
        packingLines,
      })
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      setResult({ pdfUrl: url, shippingId: data.shippingId, discount: data.discount ?? 0 })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to ship")
      setShipping(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={() => dismissRef.current()}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-lg flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-cream-border shrink-0">
          <div className="text-sm font-semibold text-foreground">
            {result ? "Label Pengiriman" : "Gabung Pengiriman"}
          </div>
          <div className="text-xs text-muted mt-0.5">
            {displayIg(customer).toUpperCase()}
            {result
              ? <> · {checkedGroups.map((g) => g.event).join(", ")}<span className="ml-2 font-mono">#{result.shippingId}</span></>
              : <> · pilih event yang digabung</>}
          </div>
        </div>

        {result ? (
          <iframe src={result.pdfUrl} title="Label Pengiriman" className="flex-1 w-full border-0 min-h-0" />
        ) : (
          <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto">
            {loadErr ? (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{loadErr}</div>
            ) : !allGroups ? (
              <div className="py-8 text-center text-sm text-faint">Memuat event…</div>
            ) : allGroups.length < 2 ? (
              <div className="rounded-lg bg-cream/50 px-4 py-3 text-sm text-muted">
                Customer ini hanya punya satu event siap kirim — tidak ada yang bisa digabung.
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  {allGroups.map((g) => {
                    const isOn = checked.has(g.event)
                    return (
                      <label
                        key={g.event}
                        className={`flex gap-3 rounded-lg border px-4 py-2 cursor-pointer transition-colors ${isOn ? "border-brand bg-brand/5" : "border-cream-border"}`}
                      >
                        <input
                          type="checkbox"
                          checked={isOn}
                          onChange={() => toggle(g.event)}
                          className="mt-0.5 rounded border-cream-border text-brand focus:ring-brand/30 cursor-pointer shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-muted mb-1">{g.event}</div>
                          <div className="flex flex-col gap-0.5">
                            {unparkedOrders(g).map((o) => (
                              <div key={o.rowNumber} className="text-sm text-foreground">{o.productName} x {o.toShip}</div>
                            ))}
                          </div>
                        </div>
                      </label>
                    )
                  })}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-xs font-medium text-muted">
                      Alamat pengiriman
                      {useTempAddress && (
                        <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-purple-100 text-purple-700">
                          Sementara
                        </span>
                      )}
                    </div>
                    <label className="inline-flex items-center gap-1.5 text-xs text-muted-strong cursor-pointer">
                      <input
                        type="checkbox"
                        checked={useTempAddress}
                        onChange={(e) => setUseTempAddress(e.target.checked)}
                        className="rounded border-cream-border text-brand focus:ring-brand/30 cursor-pointer"
                      />
                      Kirim ke alamat berbeda
                    </label>
                  </div>
                  {useTempAddress ? (
                    <>
                      <textarea
                        value={tempAddress}
                        onChange={(e) => setTempAddress(e.target.value)}
                        rows={5}
                        placeholder={"Nama Penerima\nAlamat lengkap\nNo. telepon"}
                        className="w-full border border-purple-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-500 transition-colors resize-none"
                      />
                      <p className="text-[11px] text-faint mt-1">
                        Seluruh paket gabungan akan dikirim ke alamat ini. Alamat utama customer tidak berubah.
                      </p>
                      {addressFromCustomer && (
                        <p className="text-[11px] text-purple-700 mt-1">
                          Diisi dari permintaan customer.
                        </p>
                      )}
                      {requestedAddresses.length > 1 && (
                        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mt-1">
                          Customer minta dua alamat berbeda untuk event yang digabung. Satu kotak hanya bisa satu
                          alamat — pastikan dulu ke dia, atau kirim terpisah.
                        </p>
                      )}
                    </>
                  ) : (
                    profileAddress ? (
                      <pre className="whitespace-pre-wrap font-sans text-sm text-foreground leading-relaxed">
                        {profileAddress}
                      </pre>
                    ) : (
                      <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                        Customer belum punya alamat di profil. Aktifkan toggle untuk isi alamat manual.
                      </p>
                    )
                  )}
                </div>

                <div className="rounded-lg bg-cream/50 px-4 py-3 flex flex-col gap-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted">Estimasi berat (gabungan)</span>
                    <span className="font-medium">{combinedKg} kg</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Ongkir/kg</span>
                    <span className="font-medium">Rp {ongkirPerKg.toLocaleString("id-ID")}</span>
                  </div>
                  <div className="flex justify-between border-t border-cream-border mt-1 pt-1">
                    <span className="text-muted">Total ongkir (sekali)</span>
                    <span className="font-semibold">Rp {combinedOngkir.toLocaleString("id-ID")}</span>
                  </div>
                  <div className="text-xs text-faint mt-1">
                    Ongkir ditagih sekali untuk paket gabungan. Selisihnya otomatis masuk ke invoice.
                  </div>
                  {!shipsNow && checkedGroups.length >= 2 && (
                    <div className="text-xs text-amber-700 mt-1.5">
                      Ada trip yang barangnya belum lengkap. Gabungannya dicatat sekarang dan ongkirnya langsung
                      disesuaikan — paketnya berangkat setelah semuanya tiba.
                    </div>
                  )}
                </div>

                {!canConfirm && (
                  <div className="text-xs text-amber-600">Pilih minimal 2 event untuk digabung.</div>
                )}
                {error && (
                  <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    {error}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="px-5 py-3 border-t border-cream-border flex justify-end gap-2 shrink-0">
          {result ? (
            <>
              {result.discount > 0 && (
                <span className="mr-auto text-xs text-green-700 self-center">
                  Diskon ongkir gabungan: Rp {result.discount.toLocaleString("id-ID")}
                </span>
              )}
              <a
                href={result.pdfUrl}
                download={`label-${result.shippingId}.pdf`}
                className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-xs font-medium hover:border-brand hover:text-brand transition-colors"
              >
                Download PDF
              </a>
              <button
                type="button"
                onClick={onSuccess}
                className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
              >
                Tutup
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={shipping}
                className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-xs font-medium hover:border-brand hover:text-brand transition-colors disabled:opacity-50"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={shipping || !canConfirm}
                className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors disabled:opacity-50"
              >
                {/* The button says which of the two will happen, because the
                    difference matters: one sends a box today, the other
                    promises one later. */}
                {shipping
                  ? (shipsNow ? "Mengirim…" : "Menyimpan…")
                  : shipsNow ? "Konfirmasi Gabung & Kirim" : "Gabung — tunggu sisanya"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
