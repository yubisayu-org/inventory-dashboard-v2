"use client"

import { useState } from "react"
import { displayIg, fmt } from "@/lib/format"
import type { CustomerDetail, InvoiceEvent, InvoiceOrderLine } from "@/lib/db"
import { useResizableColumns } from "@/hooks/useResizableColumns"
import InvoiceSummary from "@/components/InvoiceSummary"
import { CustomerInfoModal } from "./CustomerInfoModal"
import { InvoiceMessageActions } from "./InvoiceMessageActions"
import { RefundFromInvoiceModal } from "./RefundFromInvoiceModal"

export function EventCard({
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
  const { eta, status, shipments, showShipments, orders, totals } = event
  const { widths, startResize } = useResizableColumns({ order: 220, unit: 60, price: 100, subtotal: 100, ready: 60, refund: 32 })
  const shipmentCount = shipments.length

  return (
    <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 bg-cream border-b border-cream-border">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-foreground">{displayIg(customer).toUpperCase()}</span>
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
              <td className="px-4 py-2 text-right">{fmt(totals.subtotal)}</td>
              <td className="px-4 py-2 text-right">{totals.arrive}</td>
              <td className="px-2 py-2" />
            </tr>
          </tbody>
        </table>
      </div>

      {/* Invoice summary */}
      <InvoiceSummary event={event} actions={<InvoiceMessageActions event={event} />} />

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
