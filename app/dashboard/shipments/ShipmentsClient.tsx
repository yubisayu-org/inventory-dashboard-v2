"use client"

import { displayIg } from "@/lib/format"
import TableSkeleton from "@/components/TableSkeleton"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ShippingRecord } from "@/lib/db"
import { generateShippingLabel, generateMultipleShippingLabels } from "@/lib/shipping-label"
import type { ShippingLabelParams } from "@/lib/shipping-label"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import { copyToClipboard } from "@/lib/clipboard"
import { useMessageDelivery } from "@/hooks/useMessageDelivery"
import { waLink } from "@/lib/message-delivery"
import { buildShipmentConfirmMessage } from "@/lib/shipment-message"
import { useMessageTemplates } from "@/hooks/useMessageTemplates"
import { useBusinessProfile } from "@/hooks/useBusinessProfile"
import DataGrid, {
  numericFilter,
  textContainsFilter,
  booleanFilter,
  type ColumnDef,
  type RowSelectionState,
} from "@/components/DataGrid"
import { InvoiceDetailDrawer } from "@/app/dashboard/invoice/InvoiceDetailDrawer"
import SearchableSelect from "@/components/SearchableSelect"

const fmt = (n: number) => n.toLocaleString("id-ID")

// Time-window options for the shipments filter (click-only dropdown).
const WINDOW_OPTIONS = [
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last week" },
  { value: "30", label: "Last month" },
  { value: "all", label: "All shipments" },
]

// A grid row may represent several DB shipment rows that were shipped together
// (same merge_group). It carries the underlying rowNumbers so actions (resi
// edit, label) apply to the whole group.
interface DisplayShipment extends ShippingRecord {
  rowNumbers: number[]
  mergedCount: number
}

/** Collapse rows sharing a merge_group into one combined entry. */
function collapseMerged(rows: ShippingRecord[]): DisplayShipment[] {
  const groups = new Map<string, ShippingRecord[]>()
  const result: DisplayShipment[] = []
  for (const r of rows) {
    if (!r.mergeGroup) {
      result.push({ ...r, rowNumbers: [r.rowNumber], mergedCount: 1 })
    } else {
      const arr = groups.get(r.mergeGroup)
      if (arr) arr.push(r)
      else groups.set(r.mergeGroup, [r])
    }
  }
  for (const arr of groups.values()) {
    const sorted = [...arr].sort((a, b) => Number(a.shippingId) - Number(b.shippingId))
    const primary = sorted[0]
    const lines = sorted.flatMap((s) =>
      s.invoicing.split("\n").filter(Boolean).map((l) => `[${s.event}] ${l}`),
    )
    result.push({
      ...primary,
      event: sorted.map((s) => s.event).join(", "),
      // All rows of a merge share one shipping_id, so show it once.
      shippingId: primary.shippingId,
      invoicing: lines.join("\n"),
      weightEstimation: sorted.reduce((s, x) => s + x.weightEstimation, 0),
      // A merge group ships as one parcel, and only its primary row carries
      // weight — so a correction on that row is the group's correction.
      weightCharged: sorted.find((s) => s.weightCharged !== null)?.weightCharged ?? null,
      ongkirTotal: sorted.reduce((s, x) => s + x.ongkirTotal, 0),
      trackingNumber: sorted.find((s) => s.trackingNumber)?.trackingNumber ?? "",
      // temp_address is replicated across every row in a merge group so
      // reading from any one works — but defensively pick the first non-null
      // in case partial writes ever land.
      tempAddress: sorted.find((s) => s.tempAddress)?.tempAddress ?? null,
      rowNumbers: sorted.map((s) => s.rowNumber),
      mergedCount: sorted.length,
    })
  }
  return result
}

// ─── Shipment confirmation message ────────────────────────────────────────

type CopyState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "copied" }
  | { status: "error"; message: string }

// Marks a shipment that collapses several events into one parcel. Icon instead
// of a "Gabung" pill so it doesn't wrap under the (already stacked) event names;
// the count lives in the tooltip.
function MergedIcon({ count }: { count: number }) {
  return (
    <svg
      role="img"
      aria-label={`Konsolidasi ${count} event`}
      className="ml-1 inline-block align-[-0.15em] text-amber-600 shrink-0"
      width="13" height="13" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    >
      <title>{`Konsolidasi ${count} event`}</title>
      <path d="m8 6 4-4 4 4" />
      <path d="M12 2v10.3a4 4 0 0 1-1.172 2.872L4 22" />
      <path d="m20 22-5-5" />
    </svg>
  )
}

function CopyShipmentMessageButton({ record }: { record: DisplayShipment }) {
  const [state, setState] = useState<CopyState>({ status: "idle" })
  const templates = useMessageTemplates()
  const toWhatsApp = useMessageDelivery().shipment === "whatsapp"
  const businessProfile = useBusinessProfile()

  useEffect(() => {
    if (state.status === "idle") return
    const delay = state.status === "error" ? 3000 : 1500
    const timer = setTimeout(() => setState({ status: "idle" }), delay)
    return () => clearTimeout(timer)
  }, [state.status])

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    setState({ status: "loading" })
    try {
      // Skip the customer fetch when the shipment carries its own temp address —
      // we already have the address we need on the row. Unless the message is
      // going to WhatsApp, which needs her number, and the row does not carry
      // one.
      const detail = record.tempAddress && !toWhatsApp
        ? null
        : await fetch(`/api/sheets/customer?id=${encodeURIComponent(record.customer)}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
      const message = buildShipmentConfirmMessage({
        event: record.event,
        customer: record.customer,
        // Prefer the one-time temp address if this shipment was sent to it,
        // so a re-copy months later still shows where the box actually went.
        dataDiri: record.tempAddress ?? detail?.dataDiri ?? "",
        // The `invoicing` field already prefixes merged-event lines with
        // "[event]" so the customer can tell which event each item came from.
        items: record.invoicing.split("\n").filter(Boolean),
      }, templates?.shipment, businessProfile?.publicSiteUrl)
      if (toWhatsApp) {
        const win = window.open(waLink(detail?.whatsapp, message), "_blank", "noopener")
        if (win) { setState({ status: "idle" }); return }
      }
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
      title={status === "error" ? state.message
        : toWhatsApp ? "Kirim pesan konfirmasi lewat WhatsApp" : "Copy pesan konfirmasi pengiriman"}
      className={`p-1 transition-colors rounded disabled:opacity-50 ${
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

// ─── LabelModal ───────────────────────────────────────────────────────────

function LabelModal({
  record,
  onClose,
}: {
  record: ShippingRecord
  onClose: () => void
}) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let url: string | null = null
    let cancelled = false

    async function generate() {
      try {
        // Skip the customer fetch when the shipment already carries a temp
        // address — we don't need the customer profile in that case.
        const detail = record.tempAddress
          ? null
          : await fetch(`/api/sheets/customer?id=${encodeURIComponent(record.customer)}`)
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
        const blob = await generateShippingLabel({
          event: record.event,
          customer: record.customer,
          shippingId: record.shippingId,
          // The temp address is what was actually printed at ship time, so
          // reprints render it verbatim — even if the customer's permanent
          // address has changed since.
          dataDiri: record.tempAddress ?? detail?.dataDiri ?? "",
          packingLines: record.invoicing.split("\n").filter(Boolean),
        })
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setPdfUrl(url)
      } catch {
        if (!cancelled) setError("Gagal membuat label")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    generate()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [record])

  useModalDismiss(onClose)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-lg flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-cream-border shrink-0">
          <div className="text-sm font-semibold text-foreground">Label Pengiriman</div>
          <div className="text-xs text-muted mt-0.5">
            {displayIg(record.customer).toUpperCase()} · {record.event}
            <span className="ml-2 font-mono">#{record.shippingId}</span>
          </div>
        </div>

        {loading && (
          <div className="flex-1 flex items-center justify-center py-16 text-sm text-faint">
            Membuat label…
          </div>
        )}
        {error && (
          <div className="flex-1 flex items-center justify-center py-16 text-sm text-red-500">
            {error}
          </div>
        )}
        {pdfUrl && (
          <iframe
            src={pdfUrl}
            title="Label Pengiriman"
            className="flex-1 w-full border-0 min-h-0"
            style={{ minHeight: "400px" }}
          />
        )}

        <div className="px-5 py-3 border-t border-cream-border flex justify-end gap-2 shrink-0">
          {pdfUrl && (
            <a
              href={pdfUrl}
              download={`label-${record.shippingId}.pdf`}
              className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-xs font-medium hover:border-brand hover:text-brand transition-colors"
            >
              Download PDF
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── EditResiModal ────────────────────────────────────────────────────────

function EditResiModal({
  record,
  onClose,
  onSaved,
}: {
  record: ShippingRecord
  onClose: () => void
  onSaved: (trackingNumber: string) => void
}) {
  const [value, setValue] = useState(record.trackingNumber)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useModalDismiss(onClose)

  async function handleSave() {
    if (value === record.trackingNumber) { onClose(); return }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/shipments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumber: record.rowNumber, trackingNumber: value }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onSaved(value)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan")
    } finally {
      setSaving(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleSave()
    if (e.key === "Escape") onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-cream-border">
          <div className="text-sm font-semibold text-foreground">Edit Nomor Resi</div>
          <div className="text-xs text-muted mt-0.5">
            {displayIg(record.customer).toUpperCase()} · <span className="font-mono">#{record.shippingId}</span>
          </div>
        </div>

        <div className="px-5 py-4 flex flex-col gap-2">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={saving}
            placeholder="Masukkan nomor resi"
            className="w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-50"
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="px-5 py-3 border-t border-cream-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg border border-cream-border text-muted-strong text-xs font-medium hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {saving ? "Menyimpan…" : "Simpan"}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The kilos this parcel was actually billed at.
 *
 * weight_estimation is the raw weight on older rows and the rounded one on
 * newer, and a merged partner can carry a weight with no charge at all. What
 * was paid, divided by the rate, is true on every row — and it is what a
 * correction is a correction to.
 */
function billedKg(r: {
  weightEstimation: number; ongkir: number; ongkirTotal: number; mergeGroup?: string | null
}): number {
  // What was actually paid, where anything was paid.
  if (r.ongkir > 0 && r.ongkirTotal > 0) return Math.round(r.ongkirTotal / r.ongkir)
  // A merged partner's weight lives on the primary row; this one cost nothing.
  if (r.mergeGroup) return 0
  // Older rows kept the raw weight and never got a total. The courier still
  // rounded it up, so this is what it would have been charged at.
  return Math.ceil(r.weightEstimation)
}

/** What this parcel cost, once a corrected weight says the estimate was wrong. */
function chargedTotal(r: {
  weightEstimation: number; ongkir: number; ongkirTotal: number
  mergeGroup?: string | null; weightCharged: number | null
}): number {
  return r.weightCharged !== null ? r.weightCharged * r.ongkir : r.ongkirTotal
}

// ─── EditWeightModal ──────────────────────────────────────────────────────
//
// The estimate is what the invoice billed. This records what the courier
// actually charged, which is only worth typing when the two disagree — leave
// it blank and nothing is stored, which is most parcels.
//
// It confirms before saving because it changes what a customer owes, and does
// so after her parcel has already gone.

function EditWeightModal({
  record,
  onClose,
  onSaved,
}: {
  record: DisplayShipment
  onClose: () => void
  onSaved: () => void
}) {
  const [value, setValue] = useState(record.weightCharged === null ? "" : String(record.weightCharged))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useModalDismiss(onClose)

  const typed = value.trim()
  const charged = typed === "" ? null : Number(typed)
  const estimated = billedKg(record)
  const difference = charged === null ? 0 : (charged - estimated) * (record.ongkir || 0)

  async function handleSave() {
    if (charged !== null && (!Number.isInteger(charged) || charged < 1)) {
      setError("Berat harus bilangan bulat kilogram")
      return
    }
    if (charged === record.weightCharged) { onClose(); return }
    if (difference !== 0 && !confirm(
      difference > 0
        ? `Tagihan ${displayIg(record.customer).toUpperCase()} bertambah Rp ${difference.toLocaleString("id-ID")}. Lanjutkan?`
        : `Tagihan ${displayIg(record.customer).toUpperCase()} berkurang Rp ${(-difference).toLocaleString("id-ID")}. Lanjutkan?`,
    )) return

    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/shipments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumber: record.rowNumber, weightCharged: charged }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-sm flex flex-col gap-3 p-5" onClick={(e) => e.stopPropagation()}>
        <div>
          <h3 className="text-sm font-semibold text-foreground">Berat ditagih kurir</h3>
          <p className="text-xs text-muted mt-1">
            {record.event} · {displayIg(record.customer)} · ditagih{" "}
            <span className="font-semibold text-foreground">{estimated} kg</span>
          </p>
        </div>
        <input
          ref={inputRef}
          type="number"
          min="1"
          step="1"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") onClose() }}
          placeholder="Kosongkan jika sesuai estimasi"
          className="w-full px-3 py-2 rounded-lg border border-cream-border text-sm tabular-nums"
        />
        {difference !== 0 && (
          <p className={`text-xs ${difference > 0 ? "text-red-700" : "text-green-700"}`}>
            {difference > 0 ? "Ongkir tambahan" : "Ongkir berkurang"}{" "}
            <span className="font-semibold tabular-nums">Rp {Math.abs(difference).toLocaleString("id-ID")}</span>
            {" "}— pelanggan akan diberi tahu.
          </p>
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Batal</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm disabled:opacity-50"
          >
            {saving ? "Menyimpan…" : "Simpan"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── EditTempAddressModal ─────────────────────────────────────────────────

function EditTempAddressModal({
  record,
  onClose,
  onSaved,
}: {
  record: ShippingRecord
  onClose: () => void
  onSaved: (tempAddress: string | null) => void
}) {
  const [value, setValue] = useState(record.tempAddress ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { textareaRef.current?.focus() }, [])
  useModalDismiss(onClose)

  async function persist(next: string | null) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/shipments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumber: record.rowNumber, tempAddress: next }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onSaved(next)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan")
    } finally {
      setSaving(false)
    }
  }

  async function handleSave() {
    const trimmed = value.trim()
    const next = trimmed === "" ? null : trimmed
    if (next === (record.tempAddress ?? null)) { onClose(); return }
    await persist(next)
  }

  async function handleClear() {
    if (!record.tempAddress) { onClose(); return }
    if (!confirm("Hapus alamat sementara? Label berikutnya akan pakai alamat utama customer.")) return
    await persist(null)
  }

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
        <div className="px-5 py-4 border-b border-cream-border">
          <div className="text-sm font-semibold text-foreground">
            {record.tempAddress ? "Edit Alamat Sementara" : "Set Alamat Sementara"}
          </div>
          <div className="text-xs text-muted mt-0.5">
            {displayIg(record.customer).toUpperCase()} · <span className="font-mono">#{record.shippingId}</span>
          </div>
        </div>

        <div className="px-5 py-4 flex flex-col gap-2">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={saving}
            rows={6}
            placeholder={"Nama Penerima\nAlamat lengkap\nNo. telepon"}
            className="w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-500 transition-colors disabled:opacity-50 resize-none"
          />
          <p className="text-[11px] text-faint">
            Alamat utama customer tidak berubah. Kosongkan untuk pakai alamat utama lagi.
          </p>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="px-5 py-3 border-t border-cream-border flex justify-end gap-2">
          {record.tempAddress && (
            <button
              type="button"
              onClick={handleClear}
              disabled={saving}
              className="mr-auto px-3 py-1.5 rounded-lg border border-cream-border text-red-500 text-xs font-medium hover:border-red-400 hover:bg-red-50 disabled:opacity-50 transition-colors"
            >
              Hapus
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg border border-cream-border text-muted-strong text-xs font-medium hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {saving ? "Menyimpan…" : "Simpan"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────

export default function ShipmentsClient() {
  const [data, setData] = useState<ShippingRecord[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [printingPdf, setPrintingPdf] = useState(false)
  const [labelRecord, setLabelRecord] = useState<DisplayShipment | null>(null)
  const [editResiRecord, setEditResiRecord] = useState<DisplayShipment | null>(null)
  const [editWeightRecord, setEditWeightRecord] = useState<DisplayShipment | null>(null)
  const [invoiceCustomer, setInvoiceCustomer] = useState<string | null>(null)
  const [editTempRecord, setEditTempRecord] = useState<DisplayShipment | null>(null)
  // Bound the default fetch to recent shipments so the payload stays small as
  // history grows; "all" loads everything on demand.
  const [windowDays, setWindowDays] = useState<string>("1")
  const [windowFilterOpen, setWindowFilterOpen] = useState(false)
  const windowFilterRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!windowFilterOpen) return
    const h = (e: MouseEvent) => { if (!windowFilterRef.current?.contains(e.target as Node)) setWindowFilterOpen(false) }
    document.addEventListener("mousedown", h)
    return () => document.removeEventListener("mousedown", h)
  }, [windowFilterOpen])

  async function load(days: string = windowDays) {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/sheets/shipments?days=${encodeURIComponent(days)}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to load")
      setData(json as ShippingRecord[])
      setRowSelection({})
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  // Refetch whenever the window changes (and on mount).
  useEffect(() => { load(windowDays) }, [windowDays])

  // Merged ("Ship together") rows are collapsed into one combined grid entry.
  const displayData = useMemo(() => (data ? collapseMerged(data) : []), [data])

  const selectedCount = Object.keys(rowSelection).filter((k) => rowSelection[k]).length

  async function handlePrintPdf() {
    if (selectedCount === 0) return
    const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k])
    const selected = displayData.filter((r) => selectedIds.includes(String(r.rowNumber)))
    if (selected.length === 0) return
    setPrintingPdf(true)
    try {
      // Only customers whose selected shipments have no temp address need a
      // profile lookup — for the rest, the row already carries the address
      // that was printed at ship time.
      const customersNeedingProfile = [
        ...new Set(selected.filter((r) => !r.tempAddress).map((r) => r.customer)),
      ]
      const detailEntries = await Promise.all(
        customersNeedingProfile.map(async (id) => {
          try {
            const res = await fetch(`/api/sheets/customer?id=${encodeURIComponent(id)}`)
            return [id, res.ok ? await res.json() : null] as const
          } catch {
            return [id, null] as const
          }
        })
      )
      const detailMap = Object.fromEntries(detailEntries)
      const labels: ShippingLabelParams[] = selected.map((r) => ({
        event: r.event,
        customer: r.customer,
        shippingId: r.shippingId,
        dataDiri: r.tempAddress ?? detailMap[r.customer]?.dataDiri ?? "",
        packingLines: r.invoicing.split("\n").filter(Boolean),
      }))
      const blob = await generateMultipleShippingLabels(labels)
      const url = URL.createObjectURL(blob)
      try {
        const a = document.createElement("a")
        a.href = url
        a.download = `labels-${new Date().toISOString().slice(0, 10)}.pdf`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to generate PDF")
    } finally {
      setPrintingPdf(false)
    }
  }

  const columns = useMemo<ColumnDef<DisplayShipment, unknown>[]>(
    () => [
      {
        accessorKey: "shippingId",
        header: "ID",
        filterFn: "textContains",
        size: 70,
        cell: ({ getValue }) => (
          <span className="font-mono text-xs text-muted">{getValue<string>()}</span>
        ),
      },
      {
        accessorKey: "event",
        header: "Event",
        filterFn: "textContains",
        // Wide enough for one full event code ("LSKR202603") plus the " +"
        // separator and the cell's px-4 padding, so a merged row breaks one
        // event per line instead of mid-name.
        size: 120,
        cell: ({ row, getValue }) => (
          // A merged shipment joins its events with ", ", which wraps to one
          // line per token in a narrow column — four rows for a two-event merge.
          // Clamp to two and hang the full list off the tooltip. The icon is
          // inline content so it trails the last event name instead of parking
          // at the column's right edge (line-clamp makes the text a block that
          // fills the cell, so a sibling icon gets pushed all the way over).
          <span className="line-clamp-2 break-words" title={getValue<string>()}>
            {getValue<string>()}
            {row.original.mergedCount > 1 && <MergedIcon count={row.original.mergedCount} />}
          </span>
        ),
      },
      {
        accessorKey: "customer",
        header: "Customer",
        filterFn: "textContains",
        size: 156,
        cell: ({ row }) => {
          const r = row.original
          return (
            <span className="inline-flex items-center gap-1.5">
              <span className="line-clamp-2">{displayIg(r.customer)}</span>
              {r.tempAddress ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setEditTempRecord(r) }}
                  title={`Temporary:\n${r.tempAddress}`}
                  aria-label="Temporary"
                  className="inline-flex items-center text-purple-600 hover:text-purple-800 transition-colors"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 10c0 7-8 12-8 12s-8-5-8-12a8 8 0 0 1 16 0z" />
                    <circle cx="12" cy="10" r="3" />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setEditTempRecord(r) }}
                  title="Set alamat sementara untuk shipment ini"
                  className="p-0.5 rounded text-faint hover:text-purple-600 transition-colors"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 10c0 7-8 12-8 12s-8-5-8-12a8 8 0 0 1 16 0z" />
                    <circle cx="12" cy="10" r="3" />
                  </svg>
                </button>
              )}
            </span>
          )
        },
      },
      {
        accessorKey: "customerName",
        header: "Name",
        filterFn: "textContains",
        size: 130,
        cell: ({ getValue }) => {
          const v = getValue<string>()
          return <span className={`line-clamp-2 ${v ? "" : "text-faint"}`}>{v || "—"}</span>
        },
      },
      {
        accessorKey: "invoicing",
        header: "Items",
        filterFn: "textContains",
        // 150 is DataGrid's "no width given": the header cell gets no width
        // attribute, so fixed layout hands this column all the leftover space.
        //
        // Without one such column the leftover is spread across every column
        // in proportion, which quietly fattens the 92px action column into a
        // 200px one -- and its two icons, sitting at the end of it, drift far
        // from the row they belong to. Items is the right place for slack: it
        // is the only column whose content is a sentence.
        size: 150,
        enableSorting: false,
        cell: ({ getValue }) => (
          <span className="whitespace-pre-wrap font-sans text-xs text-muted-strong leading-relaxed max-w-[200px] line-clamp-2">
            {getValue<string>()}
          </span>
        ),
      },
      {
        accessorKey: "weightEstimation",
        header: "Berat",
        filterFn: "numeric",
        size: 92,
        meta: { align: "right" },
        cell: ({ row }) => {
          const record = row.original
          const corrected = record.weightCharged !== null
          return (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setEditWeightRecord(record) }}
              className="group flex items-center justify-end gap-1.5 w-full text-right"
              title={corrected
                ? `Berat dikoreksi — semula ${fmt(billedKg(record))} kg, ditagih kurir ${fmt(record.weightCharged!)} kg`
                : "Koreksi berat jika kurir menagih berbeda"}
            >
              {/* Beside the figure, where the temporary-address marker already
                  sits. Only a corrected row carries it — which is what makes
                  the corrected one findable while scanning. */}
              {corrected && (
                <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded bg-red-50 text-red-700 shrink-0">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3v18" /><path d="M5 7h14" />
                    <path d="m3 12 2-5 2 5a2 2 0 0 1-4 0z" /><path d="m17 12 2-5 2 5a2 2 0 0 1-4 0z" />
                  </svg>
                </span>
              )}
              <span className="whitespace-nowrap">
                {corrected && (
                  <span className="text-faint line-through mr-1">{fmt(billedKg(record))}</span>
                )}
                {fmt(corrected ? record.weightCharged! : billedKg(record))} kg
              </span>
            </button>
          )
        },
      },
      {
        accessorKey: "ongkirTotal",
        header: "Ongkir",
        filterFn: "numeric",
        size: 112,
        meta: { align: "right" },
        // What the parcel cost once a corrected weight has been recorded. The
        // stored total is the estimate made at ship time, and leaving it on
        // screen beside a corrected weight showed a figure the correction had
        // already contradicted.
        cell: ({ row }) => {
          const r = row.original
          const real = chargedTotal(r)
          return (
            <span className="whitespace-nowrap">
              {real !== r.ongkirTotal && (
                <span className="text-faint line-through mr-1">{fmt(r.ongkirTotal)}</span>
              )}
              Rp {fmt(real)}
            </span>
          )
        },
      },
      {
        accessorKey: "isLastShipment",
        header: "Terakhir",
        filterFn: "boolean",
        size: 90,
        cell: ({ getValue }) =>
          getValue<boolean>() ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
              Ya
            </span>
          ) : (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-surface-sunken text-muted">
              Tidak
            </span>
          ),
      },
      {
        accessorKey: "trackingNumber",
        header: "Resi",
        filterFn: "textContains",
        size: 140,
        cell: ({ row }) => {
          const record = row.original
          return (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setEditResiRecord(record) }}
              className="group flex items-center gap-1.5 text-left min-w-0 w-full"
              title={record.trackingNumber || "Belum diisi"}
            >
              <span
                className={`text-xs truncate ${record.trackingNumber ? "text-foreground font-mono" : "text-faint italic"}`}
              >
                {record.trackingNumber || "Belum diisi"}
              </span>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-faint group-hover:text-brand transition-colors shrink-0"
              >
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
              </svg>
            </button>
          )
        },
      },
      {
        accessorKey: "createdAt",
        header: "Tanggal",
        filterFn: "dateRange",
        // Display shows the localized DD/MM/YYYY string; the dateRange filter
        // normalizes it, and sort uses the real epoch (the localized string
        // doesn't sort chronologically as text).
        sortingFn: (a, b) => a.original.createdAtTs - b.original.createdAtTs,
        size: 160,
        cell: ({ getValue }) => (
          <span className="text-xs text-faint whitespace-nowrap">{getValue<string>()}</span>
        ),
      },
      {
        accessorKey: "updatedAt",
        header: "Diperbarui",
        enableHiding: true,
        sortingFn: (a, b) => a.original.updatedAtTs - b.original.updatedAtTs,
        size: 160,
        cell: ({ getValue }) => (
          <span className="text-xs text-faint whitespace-nowrap">{getValue<string>()}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        enableHiding: false,
        size: 92,
        cell: ({ row }) => (
          <div className="flex items-center gap-1">
            <CopyShipmentMessageButton record={row.original} />
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setLabelRecord(row.original) }}
              title="Lihat label pengiriman"
              className="p-1 text-faint hover:text-brand transition-colors rounded"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
          </div>
        ),
      },
    ],
    []
  )

  const renderMobileCard = useCallback((r: DisplayShipment) => (
    <div className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{r.event}</span>
            <span className="text-xs text-faint uppercase truncate">{displayIg(r.customer)}</span>
            {r.mergedCount > 1 && <MergedIcon count={r.mergedCount} />}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <CopyShipmentMessageButton record={r} />
          <button type="button" onClick={(e) => { e.stopPropagation(); setLabelRecord(r) }} title="Lihat label pengiriman" className="p-1 text-faint hover:text-brand transition-colors rounded">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>
      <div className="text-xs text-muted tabular-nums">
        {fmt(r.weightEstimation)} KG · Rp {fmt(r.ongkirTotal)}
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setEditResiRecord(r) }}
        className="group flex items-center justify-between gap-1.5 text-left pt-2.5 border-t border-cream-border"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <span className={`text-xs truncate ${r.trackingNumber ? "text-foreground font-mono" : "text-faint italic"}`}>
            {r.trackingNumber || "Resi belum diisi"}
          </span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-faint group-hover:text-brand transition-colors shrink-0">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
          </svg>
        </span>
        <span className="text-xs text-faint font-mono shrink-0">{r.shippingId}</span>
      </button>
    </div>
  ), [])

  const toolbarExtra = (
    <>
      {/* Desktop: full dropdown. */}
      <div className="hidden md:block w-40 shrink-0" title="Rentang waktu shipment yang dimuat">
        <SearchableSelect
          value={windowDays}
          onChange={setWindowDays}
          options={WINDOW_OPTIONS}
          disabled={loading}
          searchable={false}
        />
      </div>
      {/* Mobile: icon-only trigger + options popover, so the row stays compact. */}
      <div className="md:hidden relative shrink-0" ref={windowFilterRef}>
        <button
          type="button"
          onClick={() => setWindowFilterOpen((o) => !o)}
          disabled={loading}
          aria-label="Filter time window"
          className="inline-flex items-center h-[38px] px-3 rounded-lg border border-cream-border bg-white text-sm text-muted-strong active:border-brand active:text-brand disabled:opacity-50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
        </button>
        {windowFilterOpen && (
          <div className="absolute right-0 top-full mt-1 z-30 w-40 rounded-lg border border-cream-border bg-white shadow-lg p-1.5 flex flex-col">
            {WINDOW_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => { setWindowDays(value); setWindowFilterOpen(false) }}
                className={`text-left px-4 py-2 rounded-lg text-sm transition-colors ${windowDays === value ? "bg-brand-light text-brand font-medium" : "text-muted-strong hover:bg-cream"}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )

  const printButton = (
    <button
      type="button"
      onClick={handlePrintPdf}
      disabled={printingPdf || selectedCount === 0}
      className="shrink-0 inline-flex items-center gap-1.5 h-[38px] text-sm font-medium text-white bg-brand hover:bg-brand/90 disabled:opacity-50 transition-colors px-4 rounded-lg whitespace-nowrap"
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
      >
        <polyline points="6 9 6 2 18 2 18 9" />
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
        <rect x="6" y="14" width="12" height="8" />
      </svg>
      <span className="hidden sm:inline">
        {printingPdf ? "Generating…" : `Print ${selectedCount} Label${selectedCount === 1 ? "" : "s"}`}
      </span>
      <span className="sm:hidden inline-block min-w-[1.5rem] text-center tabular-nums">{printingPdf ? "…" : selectedCount}</span>
    </button>
  )

  return (
    <div className="flex flex-col gap-4">
      {loading && <TableSkeleton />}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {!loading && !error && data && (
        <DataGrid<DisplayShipment>
          data={displayData}
          columns={columns}
          getRowId={(row) => String(row.rowNumber)}
          searchPlaceholder="Cari shipment…"
          fullWidthSearch
          tightToolbar
          boldUppercaseHeader
          hideRowCount
          toolbarExtra={toolbarExtra}
          toolbarExtraEnd={printButton}
          enableRowSelection
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          onRowClick={(row) => setInvoiceCustomer(row.customer)}
          initialVisibility={{ updatedAt: false, isLastShipment: false, createdAt: false }}
          initialSorting={[{ id: "createdAt", desc: true }]}
          renderMobileCard={renderMobileCard}
          paginationVariant="simple"
        />
      )}
      {!loading && !error && data && data.length === 0 && windowDays !== "all" && (
        <div className="text-center text-sm text-faint -mt-1">
          Tidak ada shipment dalam rentang ini.{" "}
          <button
            type="button"
            onClick={() => setWindowDays("all")}
            className="font-medium text-brand hover:underline"
          >
            Muat semua shipment
          </button>
        </div>
      )}

      {invoiceCustomer && (
        <InvoiceDetailDrawer
          customer={invoiceCustomer}
          onClose={() => setInvoiceCustomer(null)}
        />
      )}
      {labelRecord && (
        <LabelModal record={labelRecord} onClose={() => setLabelRecord(null)} />
      )}
      {editWeightRecord && (
        <EditWeightModal
          record={editWeightRecord}
          onClose={() => setEditWeightRecord(null)}
          onSaved={() => { setEditWeightRecord(null); load() }}
        />
      )}
      {editResiRecord && (
        <EditResiModal
          record={editResiRecord}
          onClose={() => setEditResiRecord(null)}
          onSaved={(trackingNumber) =>
            setData((prev) =>
              prev?.map((r) =>
                editResiRecord.rowNumbers.includes(r.rowNumber) ? { ...r, trackingNumber } : r
              ) ?? null
            )
          }
        />
      )}
      {editTempRecord && (
        <EditTempAddressModal
          record={editTempRecord}
          onClose={() => setEditTempRecord(null)}
          onSaved={(tempAddress) =>
            setData((prev) =>
              prev?.map((r) =>
                editTempRecord.rowNumbers.includes(r.rowNumber) ? { ...r, tempAddress } : r
              ) ?? null
            )
          }
        />
      )}
    </div>
  )
}
