"use client"

import { useEffect, useState } from "react"
import type { CustomerDetail, InvoiceEvent, InvoiceOrderLine, InvoiceResult, RefundReason } from "@/lib/db"
import { useCopyFeedback } from "@/hooks/useCopyFeedback"
import { useResizableColumns } from "@/hooks/useResizableColumns"

function formatNumber(n: number | null | undefined): string {
  const v = Number(n)
  return new Intl.NumberFormat("id-ID").format(Number.isFinite(v) ? v : 0)
}

const FIELD =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

export default function InvoiceClient() {
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<InvoiceResult | null>(null)
  const [searched, setSearched] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = query.trim()
    if (!trimmed) return
    setLoading(true)
    setError(null)
    setResult(null)
    setSearched(true)
    try {
      const res = await fetch(`/api/sheets/invoice?customer=${encodeURIComponent(trimmed)}`, { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to load")
      setResult(data as InvoiceResult)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-3xl">
      <form
        onSubmit={handleSubmit}
        className="rounded-xl border border-cream-border bg-white p-4 flex gap-2 items-center"
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="@instagram_id"
          autoComplete="off"
          className={FIELD}
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="shrink-0 px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {error && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && searched && result && result.events.length === 0 && (
        <div className="mt-4 rounded-xl border border-cream-border bg-white p-8 text-center text-gray-400 text-sm">
          No orders found for &quot;{query}&quot;.
        </div>
      )}

      {result && result.events.length > 0 && (
        <div className="mt-6 flex flex-col gap-4">
          {[...result.events].reverse().map((ev) => (
            <EventCard key={ev.eventId} event={ev} customer={result.customer} customerDetail={result.customerDetail} />
          ))}
        </div>
      )}
    </div>
  )
}

function CustomerInfoModal({
  customer,
  detail,
  onClose,
}: {
  customer: string
  detail: CustomerDetail
  onClose: () => void
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-3 border-b border-cream-border flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">{customer.toUpperCase()}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-foreground transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-4 flex flex-col gap-3 text-sm">
          {detail.whatsapp && (
            <div>
              <div className="text-xs font-medium text-gray-500 mb-0.5">WhatsApp</div>
              <div className="text-foreground">{detail.whatsapp}</div>
            </div>
          )}
          {detail.dataDiri && (
            <div>
              <div className="text-xs font-medium text-gray-500 mb-0.5">Data Diri</div>
              <pre className="whitespace-pre-wrap font-sans text-foreground leading-relaxed">{detail.dataDiri}</pre>
            </div>
          )}
          {detail.ekspedisi && (
            <div>
              <div className="text-xs font-medium text-gray-500 mb-0.5">Ekspedisi</div>
              <div className="text-foreground">{detail.ekspedisi}</div>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-cream-border flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function EventCard({
  event,
  customer,
  customerDetail,
}: {
  event: InvoiceEvent
  customer: string
  customerDetail: CustomerDetail | null
}) {
  const [infoOpen, setInfoOpen] = useState(false)
  const [refundLine, setRefundLine] = useState<InvoiceOrderLine | null>(null)
  const { eta, status, shipments, showShipments, orders, totals, invoice } = event
  const { widths, startResize } = useResizableColumns({ order: 220, unit: 60, price: 100, subtotal: 100, ready: 60, refund: 32 })
  const shipmentCount = shipments.length

  return (
    <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 bg-cream border-b border-cream-border">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-foreground">{customer.toUpperCase()}</span>
            {customerDetail && (
              <button
                type="button"
                onClick={() => setInfoOpen(true)}
                aria-label="Customer info"
                className="text-gray-400 hover:text-brand transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              </button>
            )}
          </div>
          {infoOpen && customerDetail && (
            <CustomerInfoModal customer={customer} detail={customerDetail} onClose={() => setInfoOpen(false)} />
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
            <span className="font-medium">{event.eventId}</span>
            {eta && <span className="text-gray-500">• {eta}</span>}
          </div>
          {status && (
            <div className="text-xs text-gray-500">
              <span className="font-medium text-foreground">Status:</span> {status}
            </div>
          )}
          {showShipments &&
            shipments.map((s, i) => (
              <div key={i} className="text-xs text-gray-500">
                <span className="font-medium text-foreground">
                  Resi{shipmentCount > 1 ? ` ${i + 1}/${shipmentCount}` : ""}:
                </span>{" "}
                <span className="font-mono">{s.resi}</span>
                {s.tanggalKirim && <span className="ml-2">({s.tanggalKirim})</span>}
              </div>
            ))}
        </div>
      </div>

      {/* Orders table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-cream-border">
              <th className="px-4 py-2 font-medium relative select-none" style={{ width: widths.order }}>
                Order
                <div onMouseDown={(e) => startResize("order", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.unit }}>
                Unit
                <div onMouseDown={(e) => startResize("unit", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.price }}>
                Price
                <div onMouseDown={(e) => startResize("price", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.subtotal }}>
                Subtotal
                <div onMouseDown={(e) => startResize("subtotal", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.ready }}>
                Ready
                <div onMouseDown={(e) => startResize("ready", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-2 py-2" style={{ width: widths.refund }} />
            </tr>
          </thead>
          <tbody>
            {[...orders].reverse().map((r, i) => (
              <tr key={i} className="border-b border-cream-border/60 group">
                <td className="px-4 py-2">{r.order}</td>
                <td className="px-4 py-2 text-right">{r.unit}</td>
                <td className="px-4 py-2 text-right">{r.price}</td>
                <td className="px-4 py-2 text-right">{r.subtotal}</td>
                <td className="px-4 py-2 text-right">{r.unitArrive}</td>
                <td className="px-2 py-2 text-center">
                  <button
                    type="button"
                    onClick={() => setRefundLine(r)}
                    title="Create refund for this line"
                    className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-all"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                      <path d="M3 3v5h5" />
                    </svg>
                  </button>
                </td>
              </tr>
            ))}
            <tr className="font-semibold bg-cream/40">
              <td className="px-4 py-2">Total</td>
              <td className="px-4 py-2 text-right">{totals.unit}</td>
              <td className="px-4 py-2"></td>
              <td className="px-4 py-2 text-right">{formatNumber(totals.subtotal)}</td>
              <td className="px-4 py-2 text-right">{totals.arrive}</td>
              <td className="px-2 py-2" />
            </tr>
          </tbody>
        </table>
      </div>

      {/* Invoice summary */}
      <InvoiceSummary event={event} />

      {/* Refund modal — triggered per order line */}
      {refundLine && (
        <RefundFromInvoiceModal
          line={refundLine}
          event={event.eventId}
          customer={customer}
          onClose={() => setRefundLine(null)}
        />
      )}
    </div>
  )
}



function InvoiceMessageActions({ event }: { event: InvoiceEvent }) {
  const [open, setOpen] = useState(false)
  const { copied, copy } = useCopyFeedback()
  const { message } = event

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
      >
        View message
      </button>
      <button
        type="button"
        onClick={() => copy(message)}
        className="shrink-0 px-3 py-1.5 rounded-lg border border-brand text-brand text-xs font-medium hover:bg-brand hover:text-white transition-colors"
      >
        {copied ? "Copied!" : "Copy message"}
      </button>
      {open && (
        <InvoiceMessageModal
          message={message}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

function InvoiceMessageModal({
  message,
  onClose,
}: {
  message: string
  onClose: () => void
}) {
  const { copied, copy } = useCopyFeedback()

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-3 border-b border-cream-border flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">Invoice message</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-foreground transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <pre className="px-5 py-4 overflow-auto text-sm text-foreground whitespace-pre-wrap font-sans flex-1">
          {message}
        </pre>
        <div className="px-5 py-3 border-t border-cream-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => copy(message)}
            className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
          >
            {copied ? "Copied!" : "Copy message"}
          </button>
        </div>
      </div>
    </div>
  )
}

function InvoiceSummary({ event }: { event: InvoiceEvent }) {
  const { invoice, totals } = event
  const { subtotalBarang, estimasiOngkir, biayaLainnya, total, pembayaran, sisaPelunasan } =
    invoice

  const sisaAbs = Math.abs(sisaPelunasan)
  const isRefund = sisaPelunasan < 0
  const sisaLabel = isRefund ? "Pengembalian Dana" : "Sisa Pelunasan"
  const sisaColor = sisaPelunasan <= 0 ? "text-green-700" : "text-red-600"

  return (
    <div className="px-5 py-4 bg-cream/30 border-t border-cream-border">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div className="text-sm font-semibold text-foreground">Invoice</div>
        <InvoiceMessageActions event={event} />
      </div>
      <dl className="text-sm">
        <Row label="Subtotal Barang" value={`Rp ${formatNumber(subtotalBarang)}`} />
        <Row label="Estimasi Berat" value={`${formatNumber(totals.weightKg)} kg`} />
        <Row label="Estimasi Ongkos Kirim" value={`Rp ${formatNumber(estimasiOngkir)}`} />
        {biayaLainnya > 0 && (
          <Row label="Diskon" value={`- Rp ${formatNumber(biayaLainnya)}`} />
        )}
        {biayaLainnya < 0 && (
          <Row label="Biaya Lainnya" value={`+ Rp ${formatNumber(Math.abs(biayaLainnya))}`} />
        )}
        {total > 0 && (
          <Row
            label="Total"
            value={`Rp ${formatNumber(total)}`}
            strong
            separator
          />
        )}
        <Row label="Pembayaran" value={`Rp ${formatNumber(pembayaran)}`} />
        <Row label={sisaLabel} value={`Rp ${formatNumber(sisaAbs)}`} valueClassName={sisaColor} />
      </dl>
    </div>
  )
}

// ─── Refund from invoice modal ───────────────────────────────────────────────

const REASON_LABELS: Record<RefundReason, string> = {
  overpayment: "Overpayment",
  unavailable: "Item Unavailable",
  shipping_loss: "Lost in Shipping",
  damaged: "Damaged",
  goodwill: "Goodwill",
  other: "Other",
}

const INPUT_CLASS =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

function RefundFromInvoiceModal({
  line,
  event,
  customer,
  onClose,
}: {
  line: InvoiceOrderLine
  event: string
  customer: string
  onClose: () => void
}) {
  const affectedUnitsDefault = Math.max(0, line.unit - line.unitArrive)
  const defaultReason: RefundReason = affectedUnitsDefault > 0 ? "shipping_loss" : "other"

  const [reason, setReason] = useState<RefundReason>(defaultReason)
  const [affectedUnits, setAffectedUnits] = useState(String(affectedUnitsDefault || line.unit))
  const [refundAmount, setRefundAmount] = useState(
    String((affectedUnitsDefault || line.unit) * line.rawUnitPrice),
  )
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  // Recalculate refund amount when affected units changes
  function handleAffectedUnitsChange(val: string) {
    setAffectedUnits(val)
    const n = Number(val)
    if (Number.isFinite(n) && n > 0) {
      setRefundAmount(String(n * line.rawUnitPrice))
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event,
          customer,
          reason,
          refundAmount: Number(refundAmount),
          orderId: line.orderId,
          affectedUnits: Number(affectedUnits),
          note: note.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to create")
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <form
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-sm flex flex-col gap-4 p-6"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Create Refund</div>
            <div className="text-xs text-gray-400 mt-0.5">{line.productName} × {line.unit}</div>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-brand transition-colors shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {done ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
              <circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" />
            </svg>
            <p className="text-sm font-medium text-foreground">Refund created</p>
            <p className="text-xs text-gray-400">Track it on the Refunds page</p>
            <button type="button" onClick={onClose} className="mt-1 px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 transition-colors">
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Reason</span>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value as RefundReason)}
                  disabled={saving}
                  className={INPUT_CLASS}
                >
                  {(Object.entries(REASON_LABELS) as [RefundReason, string][]).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">
                  Affected units <span className="text-gray-400 font-normal">(of {line.unit} ordered, {line.unitArrive} arrived)</span>
                </span>
                <input
                  type="number"
                  min="1"
                  max={line.unit}
                  value={affectedUnits}
                  onChange={(e) => handleAffectedUnitsChange(e.target.value)}
                  disabled={saving}
                  className={INPUT_CLASS}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Refund amount (Rp)</span>
                <input
                  type="number"
                  min="1"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                  disabled={saving}
                  className={INPUT_CLASS}
                />
                <span className="text-xs text-gray-400">
                  Auto: {Number(affectedUnits)} × Rp {new Intl.NumberFormat("id-ID").format(line.rawUnitPrice)}
                </span>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Note <span className="text-gray-400 font-normal">(optional)</span></span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={saving}
                  rows={2}
                  placeholder="e.g. Lost during international transit"
                  className={`${INPUT_CLASS} resize-none`}
                />
              </label>
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={saving || Number(refundAmount) < 1} className="px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 disabled:opacity-50 transition-colors">
                {saving ? "Creating…" : "Create Refund"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}

function Row({
  label,
  value,
  strong,
  separator,
  valueClassName,
}: {
  label: string
  value: string
  strong?: boolean
  separator?: boolean
  valueClassName?: string
}) {
  return (
    <div
      className={`flex justify-between py-1 ${
        separator ? "border-t border-cream-border mt-1 pt-2" : ""
      } ${strong ? "font-semibold" : ""}`}
    >
      <dt className="text-gray-600">{label}</dt>
      <dd className={valueClassName ?? "text-foreground"}>{value}</dd>
    </div>
  )
}
