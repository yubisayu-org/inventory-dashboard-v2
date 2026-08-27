"use client"

import { fmt } from "@/lib/format"
import type { InvoiceEvent } from "@/lib/db"
import type { ReactNode } from "react"

export default function InvoiceSummary({
  event,
  actions,
  leftPadding = "pl-5",
  tinted = true,
}: {
  event: InvoiceEvent
  actions?: ReactNode
  /** Override the left padding so the summary can line up with a caller's
   *  own indented layout (e.g. an expanded row with a caret column). */
  leftPadding?: string
  /** The wash marks where the lines end and the money starts, and wants both
   *  edges of whatever it sits in. Off for a caller whose container starts
   *  part-way across the row -- a band that stops in open space reads as a
   *  mistake rather than as a heading. */
  tinted?: boolean
}) {
  const { invoice, totals } = event
  const { subtotalBarang, estimasiOngkir, biayaLainnya, total, pembayaran, sisaPelunasan } =
    invoice

  const sisaAbs = Math.abs(sisaPelunasan)
  const isRefund = sisaPelunasan < 0
  const sisaLabel = isRefund ? "Pengembalian Dana" : "Sisa Pelunasan"
  const sisaColor = sisaPelunasan <= 0 ? "text-green-700" : "text-red-600"

  return (
    <div className={`${leftPadding} pr-5 py-4 border-t border-cream-border ${tinted ? "bg-cream/30" : ""}`}>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div className="text-sm font-semibold text-brand">Invoice</div>
        {actions}
      </div>
      <dl className="text-sm">
        <Row label="Subtotal Barang" value={`Rp ${fmt(subtotalBarang)}`} />
        <Row label="Estimasi Berat" value={`${fmt(totals.weightKg)} kg`} />
        <Row label="Estimasi Ongkos Kirim" value={`Rp ${fmt(estimasiOngkir)}`} />
        {biayaLainnya > 0 && (
          <Row label="Biaya Lainnya" value={`+ Rp ${fmt(biayaLainnya)}`} />
        )}
        {biayaLainnya < 0 && (
          <Row label="Diskon" value={`- Rp ${fmt(Math.abs(biayaLainnya))}`} />
        )}
        {total > 0 && (
          <Row label="Total" value={`Rp ${fmt(total)}`} strong separator />
        )}
        <Row label="Pembayaran" value={`Rp ${fmt(pembayaran)}`} />
        <Row label={sisaLabel} value={`Rp ${fmt(sisaAbs)}`} valueClassName={sisaColor} />
      </dl>
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
      <dt className="text-muted-strong">{label}</dt>
      <dd className={valueClassName ?? "text-foreground"}>{value}</dd>
    </div>
  )
}
