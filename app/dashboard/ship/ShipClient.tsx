"use client"

import { displayIg } from "@/lib/format"
import TableSkeleton from "@/components/TableSkeleton"
import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import type { ShipCustomer, ShipOrdersParams, ShipSegment, ShipStatus, ShipOrdersFiltered, PaymentStatus } from "@/lib/db"
import { normalizeId } from "@/lib/db/helpers"
import { generateShippingLabel } from "@/lib/shipping-label"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import { useResizableColumns } from "@/hooks/useResizableColumns"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import EventSelect from "@/components/EventSelect"
import { InvoiceDetailDrawer } from "@/app/dashboard/invoice/InvoiceDetailDrawer"
import { copyToClipboard } from "@/lib/clipboard"
import { buildShipmentConfirmMessage } from "@/lib/shipment-message"

type Segment = ShipSegment

const SEGMENTS: { id: Segment; label: string }[] = [
  { id: "all", label: "Semua" },
  { id: "not_arrived", label: "Belum Tiba" },
  { id: "partial", label: "Tiba Sebagian" },
  { id: "ready_unpaid", label: "Belum Bayar" },
  { id: "ready", label: "Siap Dikirim" },
  { id: "shipped", label: "Sudah Dikirim" },
]

// Card badge styling per arrival/ship status (mirrors SEGMENTS labels).
const STATUS_BADGE: Record<ShipStatus, { label: string; cls: string }> = {
  not_arrived: { label: "Belum Tiba", cls: "bg-gray-100 text-gray-500" },
  partial: { label: "Tiba Sebagian", cls: "bg-amber-100 text-amber-700" },
  ready: { label: "Siap Dikirim", cls: "bg-brand/10 text-brand" },
  ready_unpaid: { label: "Belum Bayar", cls: "bg-orange-100 text-orange-700" },
  shipped: { label: "Sudah Dikirim", cls: "bg-green-100 text-green-700" },
}

// Payment-status chip rendered on every ship card so the new "paid/overpaid"
// criterion is visible at a glance.
const PAYMENT_BADGE: Record<PaymentStatus, { label: string; cls: string }> = {
  paid:     { label: "Lunas",    cls: "bg-green-100 text-green-700" },
  overpaid: { label: "Lebih",    cls: "bg-blue-100 text-blue-700" },
  partial:  { label: "Sebagian", cls: "bg-amber-100 text-amber-700" },
  unpaid:   { label: "Belum",    cls: "bg-rose-100 text-rose-700" },
  void:     { label: "Void",     cls: "bg-gray-100 text-gray-500" },
}

export default function ShipClient() {
  const router = useRouter()
  const sheetOptions = useSheetOptions()
  const [groups, setGroups] = useState<ShipCustomer[]>([])
  const [counts, setCounts] = useState<Record<Segment, number>>({ all: 0, not_arrived: 0, partial: 0, ready: 0, ready_unpaid: 0, shipped: 0 })
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
  const [invoiceCustomer, setInvoiceCustomer] = useState<string | null>(null)

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

  function refresh() {
    fetchData(segment, debouncedSearch, eventFilter)
  }

  const readyFiltered = groups.filter((c) => c.totalToShip > 0)
  const allSelected = readyFiltered.length > 0 && readyFiltered.every((c) => selected.has(`${c.customer}|${c.event}`))

  // "Ship together" is offered whenever the selected cards are all one customer;
  // the modal then fetches that customer's other shippable events to combine.
  const selectedGroups = readyFiltered.filter((c) => selected.has(`${c.customer}|${c.event}`))
  const mergeCustomers = new Set(selectedGroups.map((c) => normalizeId(c.customer)))
  const mergeEligible = selectedGroups.length >= 1 && mergeCustomers.size === 1

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
      <div className="flex items-center gap-1 rounded-xl border border-cream-border bg-white p-1">
        {SEGMENTS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => { setSegment(s.id); setSelected(new Set()) }}
            className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              segment === s.id
                ? "bg-brand text-white"
                : "text-gray-500 hover:text-foreground"
            }`}
          >
            {s.label}
            <span
              className={`text-xs rounded-full px-1.5 py-0.5 tabular-nums ${
                segment === s.id
                  ? "bg-white/20 text-white"
                  : "bg-gray-100 text-gray-500"
              }`}
            >
              {counts[s.id]}
            </span>
          </button>
        ))}
      </div>

      {/* Search + event filter + refresh */}
      <div className="flex gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cari customer…"
          className="flex-1 min-w-0 border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
        />
        <div className="w-48">
          <EventSelect
            value={eventFilter}
            onChange={setEventFilter}
            events={sheetOptions?.events ?? []}
            placeholder="Semua Event"
            clearable
          />
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="shrink-0 text-xs text-gray-500 hover:text-brand disabled:opacity-50 transition-colors px-3 py-2 rounded-lg border border-cream-border hover:border-brand"
        >
          {loading ? "…" : "Refresh"}
        </button>
      </div>

      {/* States */}
      {loading && <TableSkeleton />}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {!loading && !error && groups.length === 0 && (
        <div className="rounded-xl border border-cream-border bg-white p-12 text-center text-gray-400 text-sm">
          Tidak ada pesanan.
        </div>
      )}

      {/* Results */}
      {!loading && !error && groups.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-gray-500">
              <span className="font-semibold text-foreground">{groups.length}</span> customer
            </p>
            {readyFiltered.length > 0 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggleSelectAll}
                  disabled={bulkShipping}
                  className="text-xs text-gray-500 hover:text-brand transition-colors disabled:opacity-50"
                >
                  {allSelected ? "Deselect All" : "Select All"}
                </button>
                {mergeEligible && (
                  <button
                    type="button"
                    onClick={() => setMerging(true)}
                    disabled={bulkShipping}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-brand text-brand text-xs font-medium hover:bg-brand/5 disabled:opacity-50 transition-colors"
                  >
                    Gabung Pengiriman
                  </button>
                )}
                {selected.size > 0 && (
                  <button
                    type="button"
                    onClick={handleBulkShip}
                    disabled={bulkShipping}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
                  >
                    {bulkShipping && bulkProgress
                      ? `Mengirim ${bulkProgress.done}/${bulkProgress.total}…`
                      : `Ship ${selected.size} Customer${selected.size === 1 ? "" : "s"} →`}
                  </button>
                )}
              </div>
            )}
          </div>
          {bulkError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {bulkError}
            </div>
          )}
          {groups.map((c) => {
            const key = `${c.customer}|${c.event}`
            return (
              <CustomerCard
                key={key}
                customer={c}
                isSelected={selected.has(key)}
                onToggleSelect={c.totalToShip > 0 ? () => toggleSelect(key) : undefined}
                onShipped={() => { setSegment("all"); refresh() }}
                onOpenInvoice={() => setInvoiceCustomer(c.customer)}
              />
            )
          })}
        </>
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

type CopyState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "copied" }
  | { status: "error"; message: string }

function CopyConfirmMessageButton({ customer: c }: { customer: ShipCustomer }) {
  const [state, setState] = useState<CopyState>({ status: "idle" })

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
      const items = c.orders
        .filter((o) => o.toShip > 0)
        .map((o) => `${o.productName} x ${o.toShip}`)
      const message = buildShipmentConfirmMessage({
        event: c.event,
        customer: c.customer,
        dataDiri: c.customerDetail?.dataDiri ?? "",
        items,
      })
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
      disabled={status === "loading"}
      title={status === "error" ? state.message : "Copy pesan konfirmasi pengiriman"}
      className={`p-1 transition-colors rounded disabled:opacity-50 ${
        status === "copied" ? "text-green-600"
        : status === "error" ? "text-red-500"
        : "text-gray-400 hover:text-brand"
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
  isSelected,
  onToggleSelect,
  onShipped,
  onOpenInvoice,
}: {
  customer: ShipCustomer
  isSelected?: boolean
  onToggleSelect?: () => void
  onShipped: () => void
  onOpenInvoice: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const { customerDetail } = c
  const { widths, startResize } = useResizableColumns({ items: 200, unit: 80, unitArrive: 80, unitShip: 80, toShip: 80 })

  return (
    <div className={`rounded-xl border bg-white overflow-hidden transition-colors ${isSelected ? "border-brand" : "border-cream-border"}`}>
      <div className="px-5 py-4 bg-cream border-b border-cream-border flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={isSelected ?? false}
              onChange={onToggleSelect}
              className="mt-1 rounded border-gray-300 text-brand focus:ring-brand/30 cursor-pointer shrink-0"
            />
          )}
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={onOpenInvoice}
              className="text-sm font-semibold text-foreground hover:text-brand hover:underline cursor-pointer text-left"
              title="Lihat invoice"
            >
              {displayIg(c.customer).toUpperCase()}
            </button>
            <span className="text-sm text-gray-500 font-medium">{c.event}</span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[c.status].cls}`}>
              {STATUS_BADGE[c.status].label}
            </span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${PAYMENT_BADGE[c.paymentStatus].cls}`}>
              {PAYMENT_BADGE[c.paymentStatus].label}
            </span>
            {customerDetail?.ekspedisi && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                {customerDetail.ekspedisi}
              </span>
            )}
            {c.totalToShip > 0 && <CopyConfirmMessageButton customer={c} />}
          </div>
          {customerDetail?.whatsapp && (
            <div className="text-xs text-gray-500">{customerDetail.whatsapp}</div>
          )}
        </div>
        </div>
        {c.totalToShip > 0 && (
          <div className="shrink-0 flex flex-col items-end gap-1">
            <div className="text-lg font-bold text-foreground leading-none">{c.totalToShip}</div>
            <div className="text-xs text-gray-500">to ship</div>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="mt-1 px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
            >
              Ship
            </button>
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

      {/* Orders table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-cream-border">
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
              <tr key={o.rowNumber} className="border-b border-cream-border/60">
                <td className="px-4 py-2">{o.productName}</td>
                <td className="px-4 py-2 text-right">{o.unit}</td>
                <td className="px-4 py-2 text-right">{o.unitArrive}</td>
                <td className="px-4 py-2 text-right">{o.unitShip}</td>
                <td className={`px-4 py-2 text-right font-semibold ${o.toShip > 0 ? "text-brand" : "text-gray-400"}`}>
                  {o.toShip}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Collapsible address */}
      {customerDetail?.dataDiri && (
        <div className="border-t border-cream-border">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-3 text-xs text-gray-500 hover:text-brand transition-colors"
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
  const toShipRows = c.orders.filter((o) => o.toShip > 0)

  const dismissRef = useRef<() => void>(onClose)
  dismissRef.current = result ? onSuccess : onClose
  useModalDismiss(() => dismissRef.current())

  const urlRef = useRef<string | null>(null)
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current) }, [])

  async function handleConfirm() {
    setShipping(true)
    setError(null)
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
    try {
      const res = await fetch("/api/sheets/ship", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")

      const blob = await generateShippingLabel({
        event: c.event,
        customer: c.customer,
        shippingId: data.shippingId,
        dataDiri: c.customerDetail?.dataDiri ?? "",
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
        <div className="px-5 py-4 border-b border-cream-border shrink-0">
          <div className="text-sm font-semibold text-foreground">
            {result ? "Label Pengiriman" : "Konfirmasi Pengiriman"}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
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
              <div className="text-xs font-medium text-gray-500 mb-2">Item yang dikirim</div>
              <div className="flex flex-col gap-1">
                {toShipRows.map((o) => (
                  <div key={o.rowNumber} className="text-sm text-foreground">{o.items}</div>
                ))}
              </div>
            </div>

            {c.customerDetail?.dataDiri && (
              <div>
                <div className="text-xs font-medium text-gray-500 mb-1">Alamat pengiriman</div>
                <pre className="whitespace-pre-wrap font-sans text-sm text-foreground leading-relaxed">
                  {c.customerDetail.dataDiri}
                </pre>
              </div>
            )}

            <div className="rounded-lg bg-cream/50 px-4 py-3 flex flex-col gap-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Estimasi berat</span>
                <span className="font-medium">{c.weightKg} kg</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Ongkir/kg</span>
                <span className="font-medium">Rp {c.ongkirPerKg.toLocaleString("id-ID")}</span>
              </div>
              <div className="flex justify-between border-t border-cream-border mt-1 pt-1">
                <span className="text-gray-500">Total ongkir</span>
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
                className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
              >
                Download PDF
              </a>
              <button
                type="button"
                onClick={onSuccess}
                className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
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
                className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors disabled:opacity-50"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={shipping}
                className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors disabled:opacity-50"
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
          .filter((g) => normalizeId(g.customer) === normalizeId(customer) && g.totalToShip > 0)
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
  const customerDetail = allGroups?.[0]?.customerDetail ?? null
  const ongkirPerKg = allGroups?.[0]?.ongkirPerKg ?? 0
  const totalGram = checkedGroups.reduce((s, g) => s + g.orders.reduce((a, o) => a + o.gram * o.toShip, 0), 0)
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
    try {
      const res = await fetch("/api/sheets/ship", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer,
          ongkirPerKg,
          groups: checkedGroups.map((g) => ({
            event: g.event,
            orders: g.orders
              .filter((o) => o.toShip > 0)
              .map((o) => ({ rowNumber: o.rowNumber, productName: o.productName, toShip: o.toShip, gram: o.gram })),
          })),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")

      const packingLines: string[] = []
      for (const g of checkedGroups) {
        for (const o of g.orders.filter((o) => o.toShip > 0)) {
          packingLines.push(`[${g.event}] ${o.productName} x ${o.toShip}`)
        }
      }
      const blob = await generateShippingLabel({
        event: checkedGroups.map((g) => g.event).join(" + "),
        customer,
        shippingId: data.shippingId,
        dataDiri: customerDetail?.dataDiri ?? "",
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
          <div className="text-xs text-gray-500 mt-0.5">
            {displayIg(customer).toUpperCase()}
            {result
              ? <> · {checkedGroups.map((g) => g.event).join(" + ")}<span className="ml-2 font-mono">#{result.shippingId}</span></>
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
              <div className="py-8 text-center text-sm text-gray-400">Memuat event…</div>
            ) : allGroups.length < 2 ? (
              <div className="rounded-lg bg-cream/50 px-4 py-3 text-sm text-gray-500">
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
                        className={`flex gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${isOn ? "border-brand bg-brand/5" : "border-cream-border"}`}
                      >
                        <input
                          type="checkbox"
                          checked={isOn}
                          onChange={() => toggle(g.event)}
                          className="mt-0.5 rounded border-gray-300 text-brand focus:ring-brand/30 cursor-pointer shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-gray-500 mb-1">{g.event}</div>
                          <div className="flex flex-col gap-0.5">
                            {g.orders.filter((o) => o.toShip > 0).map((o) => (
                              <div key={o.rowNumber} className="text-sm text-foreground">{o.productName} x {o.toShip}</div>
                            ))}
                          </div>
                        </div>
                      </label>
                    )
                  })}
                </div>

                {customerDetail?.dataDiri && (
                  <div>
                    <div className="text-xs font-medium text-gray-500 mb-1">Alamat pengiriman</div>
                    <pre className="whitespace-pre-wrap font-sans text-sm text-foreground leading-relaxed">
                      {customerDetail.dataDiri}
                    </pre>
                  </div>
                )}

                <div className="rounded-lg bg-cream/50 px-4 py-3 flex flex-col gap-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Estimasi berat (gabungan)</span>
                    <span className="font-medium">{combinedKg} kg</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Ongkir/kg</span>
                    <span className="font-medium">Rp {ongkirPerKg.toLocaleString("id-ID")}</span>
                  </div>
                  <div className="flex justify-between border-t border-cream-border mt-1 pt-1">
                    <span className="text-gray-500">Total ongkir (sekali)</span>
                    <span className="font-semibold">Rp {combinedOngkir.toLocaleString("id-ID")}</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    Ongkir ditagih sekali untuk paket gabungan. Diskon ongkir gabungan otomatis diterapkan ke invoice.
                  </div>
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
                className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
              >
                Download PDF
              </a>
              <button
                type="button"
                onClick={onSuccess}
                className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
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
                className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors disabled:opacity-50"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={shipping || !canConfirm}
                className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors disabled:opacity-50"
              >
                {shipping ? "Mengirim…" : "Konfirmasi Gabung & Kirim"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
