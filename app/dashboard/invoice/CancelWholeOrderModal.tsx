"use client"

import { useState } from "react"
import type { InvoiceEvent } from "@/lib/db"
import { displayIg } from "@/lib/format"
import { useModalDismiss } from "@/hooks/useModalDismiss"

/**
 * Cancel everything this customer ordered on one trip.
 *
 * The per-line control exists for a customer who drops one item and keeps the
 * rest. This is the other case: she has gone quiet and the whole order is
 * dead. Doing that a line at a time is five confirmations, five chances to
 * miss one, and a half-cancelled order if anything interrupts.
 *
 * It reuses the same customer_cancelled path per line rather than inventing a
 * bulk one — same reduction, same stock returned to Inventory, same reason on
 * the record. What is new is that one press covers the lot.
 */
export function CancelWholeOrderModal({
  event,
  customer,
  onClose,
  onCancelled,
}: {
  event: InvoiceEvent
  customer: string
  onClose: () => void
  onCancelled: () => void
}) {
  useModalDismiss(onClose)

  // Lines already shipped are not hers to cancel — the parcel has gone, and
  // the money for it is a refund's business, not this one's.
  const cancellable = event.orders.filter((o) => o.unit > 0 && o.unitShip < o.unit)
  const alreadyGone = event.orders.filter((o) => o.unitShip > 0)

  const [receipt, setReceipt] = useState(customer)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ lines: number; returned: number } | null>(null)

  const returning = cancellable.reduce(
    (n, o) => n + Math.max(0, Math.min(o.unit - o.unitShip, o.unitBuy - o.unitShip)), 0)
  const value = cancellable.reduce((n, o) => n + o.rawUnitPrice * (o.unit - o.unitShip), 0)
  const rp = (n: number) => `Rp ${n.toLocaleString("id-ID")}`

  async function handleSubmit() {
    setSaving(true)
    setError(null)
    try {
      let returned = 0
      // One call per line, in order, so a failure halfway leaves the lines it
      // did reach genuinely cancelled rather than a transaction that claims
      // nothing happened while stock has already moved.
      for (const o of cancellable) {
        const res = await fetch("/api/sheets/orders", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "customer_cancelled",
            event: event.eventId,
            productName: o.productName,
            orderId: o.orderId,
            qty: o.unit - o.unitShip,
            receipt,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? `Gagal membatalkan ${o.productName}`)
        returned += typeof data.excessUnits === "number" ? data.excessUnits : 0
      }
      setDone({ lines: cancellable.length, returned })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal membatalkan pesanan")
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto flex flex-col gap-3 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {done ? (
          <>
            <h3 className="text-sm font-semibold text-foreground">Pesanan dibatalkan</h3>
            <p className="text-xs text-muted-strong">
              {done.lines} baris dibatalkan untuk {displayIg(customer)} · {event.eventId}.
              {done.returned > 0
                ? ` ${done.returned} unit yang sudah dibeli masuk ke Inventory.`
                : " Tidak ada unit yang perlu dikembalikan ke Inventory."}
            </p>
            <p className="text-xs text-faint">
              Kalau dia sudah membayar, kelebihannya muncul di tab <b>To check</b> pada halaman Refunds.
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onCancelled}
                className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium"
              >
                Tutup
              </button>
            </div>
          </>
        ) : (
          <>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Batalkan seluruh pesanan</h3>
              <p className="text-xs text-muted mt-1">
                {displayIg(customer)} · {event.eventId}
              </p>
            </div>

            {cancellable.length === 0 ? (
              <p className="text-xs text-muted-strong">
                Tidak ada yang bisa dibatalkan — semuanya sudah dikirim.
              </p>
            ) : (
              <>
                <div className="rounded-lg border border-cream-border bg-surface-muted p-3 flex flex-col gap-1">
                  {cancellable.map((o) => (
                    <div key={o.orderId} className="flex justify-between gap-3 text-xs">
                      <span className="flex-1 min-w-0 truncate text-foreground">{o.productName}</span>
                      <span className="tabular-nums text-muted">
                        {o.unit - o.unitShip} × {rp(o.rawUnitPrice)}
                      </span>
                    </div>
                  ))}
                  <div className="flex justify-between gap-3 text-xs font-semibold border-t border-cream-border mt-1 pt-1.5">
                    <span>Tagihannya berkurang</span>
                    <span className="tabular-nums">{rp(value)}</span>
                  </div>
                </div>

                {alreadyGone.length > 0 && (
                  <p className="text-xs text-amber-700">
                    {alreadyGone.length} baris sudah dikirim sebagian dan tidak ikut dibatalkan — paket
                    yang sudah jalan urusannya refund, bukan pembatalan.
                  </p>
                )}

                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted">
                    Catatan stok <span className="font-normal text-faint">(menempel di Inventory)</span>
                  </span>
                  <input
                    value={receipt}
                    onChange={(e) => setReceipt(e.target.value)}
                    disabled={saving}
                    className="w-full px-3 py-2 rounded-lg border border-cream-border text-sm"
                  />
                </label>

                <p className="text-xs text-muted-strong">
                  {returning > 0
                    ? `${returning} unit yang sudah dibeli akan masuk ke Inventory sebagai stok siap dijual.`
                    : "Belum ada unit yang dibeli, jadi tidak ada yang masuk Inventory."}
                </p>
              </>
            )}

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-sm disabled:opacity-50"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={saving || cancellable.length === 0}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {saving ? "Membatalkan…" : `Batalkan ${cancellable.length} baris`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
