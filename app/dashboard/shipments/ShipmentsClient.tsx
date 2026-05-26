"use client"

import { displayIg } from "@/lib/format"
import TableSkeleton from "@/components/TableSkeleton"
import { useEffect, useMemo, useRef, useState } from "react"
import type { ShippingRecord } from "@/lib/db"
import { generateShippingLabel, generateMultipleShippingLabels } from "@/lib/shipping-label"
import type { ShippingLabelParams } from "@/lib/shipping-label"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import DataGrid, {
  numericFilter,
  textContainsFilter,
  booleanFilter,
  type ColumnDef,
  type RowSelectionState,
} from "@/components/DataGrid"

const fmt = (n: number) => n.toLocaleString("id-ID")

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
      event: sorted.map((s) => s.event).join(" + "),
      // All rows of a merge share one shipping_id, so show it once.
      shippingId: primary.shippingId,
      invoicing: lines.join("\n"),
      weightEstimation: sorted.reduce((s, x) => s + x.weightEstimation, 0),
      ongkirTotal: sorted.reduce((s, x) => s + x.ongkirTotal, 0),
      trackingNumber: sorted.find((s) => s.trackingNumber)?.trackingNumber ?? "",
      rowNumbers: sorted.map((s) => s.rowNumber),
      mergedCount: sorted.length,
    })
  }
  return result
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
        const res = await fetch(`/api/sheets/customer?id=${encodeURIComponent(record.customer)}`)
        const detail = res.ok ? await res.json() : null
        const blob = await generateShippingLabel({
          event: record.event,
          customer: record.customer,
          shippingId: record.shippingId,
          dataDiri: detail?.dataDiri ?? "",
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
          <div className="text-xs text-gray-500 mt-0.5">
            {displayIg(record.customer).toUpperCase()} · {record.event}
            <span className="ml-2 font-mono">#{record.shippingId}</span>
          </div>
        </div>

        {loading && (
          <div className="flex-1 flex items-center justify-center py-16 text-sm text-gray-400">
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
              className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
            >
              Download PDF
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
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
          <div className="text-xs text-gray-500 mt-0.5">
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
            className="px-4 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
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

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/shipments")
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

  useEffect(() => { load() }, [])

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
      const uniqueCustomers = [...new Set(selected.map((r) => r.customer))]
      const detailEntries = await Promise.all(
        uniqueCustomers.map(async (id) => {
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
        dataDiri: detailMap[r.customer]?.dataDiri ?? "",
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
        size: 80,
        cell: ({ getValue }) => (
          <span className="font-mono text-xs text-gray-500">{getValue<string>()}</span>
        ),
      },
      {
        accessorKey: "event",
        header: "Event",
        filterFn: "textContains",
        size: 120,
        cell: ({ row, getValue }) => (
          <span className="flex items-center gap-1.5 flex-wrap">
            <span>{getValue<string>()}</span>
            {row.original.mergedCount > 1 && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-700">
                Gabung
              </span>
            )}
          </span>
        ),
      },
      {
        accessorKey: "customer",
        header: "Customer",
        filterFn: "textContains",
        size: 140,
        cell: ({ getValue }) => <span>{displayIg(getValue<string>())}</span>,
      },
      {
        accessorKey: "customerName",
        header: "Name",
        filterFn: "textContains",
        size: 160,
        cell: ({ getValue }) => {
          const v = getValue<string>()
          return <span className={v ? "" : "text-gray-400"}>{v || "—"}</span>
        },
      },
      {
        accessorKey: "invoicing",
        header: "Items",
        filterFn: "textContains",
        size: 220,
        enableSorting: false,
        cell: ({ getValue }) => (
          <pre className="whitespace-pre-wrap font-sans text-xs text-gray-600 leading-relaxed max-w-[200px]">
            {getValue<string>()}
          </pre>
        ),
      },
      {
        accessorKey: "weightEstimation",
        header: "Berat",
        filterFn: "numeric",
        size: 90,
        meta: { align: "right" },
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap">{fmt(getValue<number>())} kg</span>
        ),
      },
      {
        accessorKey: "ongkirTotal",
        header: "Ongkir",
        filterFn: "numeric",
        size: 120,
        meta: { align: "right" },
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap">Rp {fmt(getValue<number>())}</span>
        ),
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
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
              Tidak
            </span>
          ),
      },
      {
        accessorKey: "trackingNumber",
        header: "Resi",
        filterFn: "textContains",
        size: 200,
        cell: ({ row }) => {
          const record = row.original
          return (
            <button
              type="button"
              onClick={() => setEditResiRecord(record)}
              className="group flex items-center gap-1.5 text-left"
            >
              <span
                className={`text-xs ${record.trackingNumber ? "text-foreground font-mono" : "text-gray-400 italic"}`}
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
                className="text-gray-400 group-hover:text-brand transition-colors shrink-0"
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
        filterFn: "textContains",
        size: 160,
        cell: ({ getValue }) => (
          <span className="text-xs text-gray-400 whitespace-nowrap">{getValue<string>()}</span>
        ),
      },
      {
        accessorKey: "updatedAt",
        header: "Diperbarui",
        enableHiding: true,
        size: 160,
        cell: ({ getValue }) => (
          <span className="text-xs text-gray-400 whitespace-nowrap">{getValue<string>()}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        enableHiding: false,
        size: 44,
        cell: ({ row }) => (
          <button
            type="button"
            onClick={() => setLabelRecord(row.original)}
            title="Lihat label pengiriman"
            className="text-gray-400 hover:text-brand transition-colors"
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
        ),
      },
    ],
    []
  )

  const toolbarExtra = (
    <div className="flex items-center gap-2">
      {selectedCount > 0 && (
        <button
          type="button"
          onClick={handlePrintPdf}
          disabled={printingPdf}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-brand hover:bg-brand/90 disabled:opacity-50 transition-colors px-3 py-1.5 rounded-lg"
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
          >
            <polyline points="6 9 6 2 18 2 18 9" />
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
            <rect x="6" y="14" width="12" height="8" />
          </svg>
          {printingPdf
            ? "Generating…"
            : `Print ${selectedCount} Label${selectedCount === 1 ? "" : "s"}`}
        </button>
      )}
      <button
        type="button"
        onClick={load}
        disabled={loading}
        className="text-xs text-gray-500 hover:text-brand disabled:opacity-50 transition-colors px-3 py-1.5 rounded-lg border border-cream-border hover:border-brand"
      >
        {loading ? "…" : "Refresh"}
      </button>
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      {loading && <TableSkeleton />}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {!loading && !error && data?.length === 0 && (
        <div className="rounded-xl border border-cream-border bg-white p-12 text-center text-gray-400 text-sm">
          No shipments yet.
        </div>
      )}
      {!loading && !error && data && data.length > 0 && (
        <DataGrid<DisplayShipment>
          data={displayData}
          columns={columns}
          getRowId={(row) => String(row.rowNumber)}
          searchPlaceholder="Cari shipment…"
          toolbarExtra={toolbarExtra}
          enableRowSelection
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          initialVisibility={{ updatedAt: false }}
          initialSorting={[{ id: "createdAt", desc: true }]}
        />
      )}

      {labelRecord && (
        <LabelModal record={labelRecord} onClose={() => setLabelRecord(null)} />
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
    </div>
  )
}
