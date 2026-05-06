"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { ShippingRecord } from "@/lib/db"
import { generateShippingLabel, generateMultipleShippingLabels } from "@/lib/shipping-label"
import type { ShippingLabelParams } from "@/lib/shipping-label"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import { useResizableColumns } from "@/hooks/useResizableColumns"

type SortKey = "shippingId" | "event" | "customer" | "weightEstimation" | "ongkirTotal" | "createdAt"
type ResiFilter = "all" | "filled" | "empty"

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
            {record.customer.toUpperCase()} · {record.event}
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

export default function ShipmentsClient() {
  const [data, setData] = useState<ShippingRecord[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const [printingPdf, setPrintingPdf] = useState(false)

  const [search, setSearch] = useState("")
  const [eventFilter, setEventFilter] = useState("")
  const [resiFilter, setResiFilter] = useState<ResiFilter>("all")
  const [sortKey, setSortKey] = useState<SortKey>("createdAt")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/shipments")
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to load")
      setData(json as ShippingRecord[])
      setSelectedRows(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // Clear selection whenever filters change
  useEffect(() => { setSelectedRows(new Set()) }, [search, eventFilter, resiFilter])

  const events = useMemo(
    () => [...new Set((data ?? []).map((r) => r.event).filter(Boolean))].sort(),
    [data]
  )

  const displayed = useMemo(() => {
    let rows = data ?? []

    if (search) {
      const q = search.replace(/^@/, "").toLowerCase()
      rows = rows.filter((r) => r.customer.replace(/^@/, "").toLowerCase().includes(q))
    }
    if (eventFilter) rows = rows.filter((r) => r.event === eventFilter)
    if (resiFilter === "filled") rows = rows.filter((r) => Boolean(r.trackingNumber))
    if (resiFilter === "empty") rows = rows.filter((r) => !r.trackingNumber)

    return [...rows].sort((a, b) => {
      let cmp: number
      switch (sortKey) {
        case "shippingId":        cmp = a.shippingId.localeCompare(b.shippingId); break
        case "event":             cmp = a.event.localeCompare(b.event); break
        case "customer":          cmp = a.customer.localeCompare(b.customer); break
        case "weightEstimation":  cmp = a.weightEstimation - b.weightEstimation; break
        case "ongkirTotal":       cmp = a.ongkirTotal - b.ongkirTotal; break
        case "createdAt":         cmp = a.createdAt.localeCompare(b.createdAt); break
        default:                  cmp = 0
      }
      return sortDir === "asc" ? cmp : -cmp
    })
  }, [data, search, eventFilter, resiFilter, sortKey, sortDir])

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"))
    else { setSortKey(key); setSortDir("asc") }
  }

  function toggleSelect(rowNumber: number) {
    setSelectedRows((prev) => {
      const next = new Set(prev)
      if (next.has(rowNumber)) next.delete(rowNumber)
      else next.add(rowNumber)
      return next
    })
  }

  const allRowNumbers = displayed.map((r) => r.rowNumber)
  const allSelected = allRowNumbers.length > 0 && allRowNumbers.every((n) => selectedRows.has(n))

  function toggleSelectAll() {
    setSelectedRows(allSelected ? new Set() : new Set(allRowNumbers))
  }

  async function handlePrintPdf() {
    const selected = displayed.filter((r) => selectedRows.has(r.rowNumber))
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

  const hasFilters = search || eventFilter || resiFilter !== "all"

  const { widths, startResize } = useResizableColumns({
    checkbox: 40, shippingId: 70, event: 120, customer: 140,
    items: 200, weightEstimation: 80, ongkirTotal: 110,
    isLastShipment: 80, resi: 180, createdAt: 160, action: 44,
  })

  return (
    <div className="flex flex-col gap-4">
      {/* Filters + actions toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cari customer…"
          className="flex-1 min-w-[160px] border border-cream-border rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
        />
        <select
          value={eventFilter}
          onChange={(e) => setEventFilter(e.target.value)}
          className="border border-cream-border rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors text-gray-600"
        >
          <option value="">Semua Event</option>
          {events.map((ev) => (
            <option key={ev} value={ev}>{ev}</option>
          ))}
        </select>
        <select
          value={resiFilter}
          onChange={(e) => setResiFilter(e.target.value as ResiFilter)}
          className="border border-cream-border rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors text-gray-600"
        >
          <option value="all">Semua Resi</option>
          <option value="filled">Sudah diisi</option>
          <option value="empty">Belum diisi</option>
        </select>
        {hasFilters && (
          <button
            type="button"
            onClick={() => { setSearch(""); setEventFilter(""); setResiFilter("all") }}
            className="text-xs text-gray-400 hover:text-brand transition-colors px-2 py-1.5"
          >
            Reset
          </button>
        )}

        <div className="flex items-center gap-2 ml-auto">
          {selectedRows.size > 0 && (
            <button
              type="button"
              onClick={handlePrintPdf}
              disabled={printingPdf}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-brand hover:bg-brand/90 disabled:opacity-50 transition-colors px-3 py-1.5 rounded-lg"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 6 2 18 2 18 9" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" />
              </svg>
              {printingPdf ? "Generating…" : `Print ${selectedRows.size} Label${selectedRows.size === 1 ? "" : "s"}`}
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
      </div>

      {loading && (
        <div className="text-sm text-gray-400 py-12 text-center">Loading…</div>
      )}
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
        <>
          <div className="text-xs text-gray-400">
            {displayed.length === data.length
              ? `${data.length} shipment${data.length === 1 ? "" : "s"}`
              : `${displayed.length} dari ${data.length} shipment`}
          </div>
          {displayed.length === 0 ? (
            <div className="rounded-xl border border-cream-border bg-white p-12 text-center text-gray-400 text-sm">
              Tidak ada hasil yang cocok.
            </div>
          ) : (
            <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-cream-border bg-cream">
                      <th className="pl-4 pr-2 py-3 relative select-none" style={{ width: widths.checkbox }}>
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleSelectAll}
                          className="rounded border-gray-300 text-brand focus:ring-brand/30 cursor-pointer"
                        />
                        <div onMouseDown={(e) => startResize("checkbox", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                      </th>
                      <SortTh label="ID" sortKey="shippingId" current={sortKey} dir={sortDir} onSort={handleSort} width={widths.shippingId} onStartResize={(e) => startResize("shippingId", e)} />
                      <SortTh label="Event" sortKey="event" current={sortKey} dir={sortDir} onSort={handleSort} width={widths.event} onStartResize={(e) => startResize("event", e)} />
                      <SortTh label="Customer" sortKey="customer" current={sortKey} dir={sortDir} onSort={handleSort} width={widths.customer} onStartResize={(e) => startResize("customer", e)} />
                      <th className="px-4 py-3 font-medium relative select-none" style={{ width: widths.items }}>
                        Items
                        <div onMouseDown={(e) => startResize("items", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                      </th>
                      <SortTh label="Berat" sortKey="weightEstimation" current={sortKey} dir={sortDir} onSort={handleSort} align="right" width={widths.weightEstimation} onStartResize={(e) => startResize("weightEstimation", e)} />
                      <SortTh label="Ongkir" sortKey="ongkirTotal" current={sortKey} dir={sortDir} onSort={handleSort} align="right" width={widths.ongkirTotal} onStartResize={(e) => startResize("ongkirTotal", e)} />
                      <th className="px-4 py-3 font-medium relative select-none" style={{ width: widths.isLastShipment }}>
                        Terakhir
                        <div onMouseDown={(e) => startResize("isLastShipment", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                      </th>
                      <th className="px-4 py-3 font-medium relative select-none" style={{ width: widths.resi }}>
                        Resi
                        <div onMouseDown={(e) => startResize("resi", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                      </th>
                      <SortTh label="Tanggal" sortKey="createdAt" current={sortKey} dir={sortDir} onSort={handleSort} width={widths.createdAt} onStartResize={(e) => startResize("createdAt", e)} />
                      <th className="px-4 py-3 font-medium relative select-none" style={{ width: widths.action }}>
                        <div onMouseDown={(e) => startResize("action", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayed.map((record) => (
                      <ShipmentRow
                        key={record.rowNumber}
                        record={record}
                        isSelected={selectedRows.has(record.rowNumber)}
                        onToggleSelect={() => toggleSelect(record.rowNumber)}
                        onUpdated={(trackingNumber) =>
                          setData((prev) =>
                            prev?.map((r) =>
                              r.rowNumber === record.rowNumber ? { ...r, trackingNumber } : r
                            ) ?? null
                          )
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SortTh({
  label,
  sortKey,
  current,
  dir,
  onSort,
  align = "left",
  width,
  onStartResize,
}: {
  label: string
  sortKey: SortKey
  current: SortKey
  dir: "asc" | "desc"
  onSort: (key: SortKey) => void
  align?: "left" | "right"
  width?: number
  onStartResize?: (e: React.MouseEvent) => void
}) {
  const active = current === sortKey
  return (
    <th className={`px-4 py-3 font-medium relative select-none ${align === "right" ? "text-right" : ""}`} style={width != null ? { width } : undefined}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-brand transition-colors ${active ? "text-brand" : ""}`}
      >
        {label}
        <span className="text-[10px] leading-none">
          {active ? (dir === "asc" ? "↑" : "↓") : <span className="text-gray-300">↕</span>}
        </span>
      </button>
      {onStartResize && (
        <div onMouseDown={onStartResize} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
      )}
    </th>
  )
}

function ShipmentRow({
  record,
  onUpdated,
  isSelected,
  onToggleSelect,
}: {
  record: ShippingRecord
  onUpdated: (trackingNumber: string) => void
  isSelected: boolean
  onToggleSelect: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(record.trackingNumber)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showLabel, setShowLabel] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  async function handleSave() {
    if (value === record.trackingNumber) { setEditing(false); return }
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch("/api/sheets/shipments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumber: record.rowNumber, trackingNumber: value }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onUpdated(value)
      setEditing(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleSave()
    if (e.key === "Escape") { setValue(record.trackingNumber); setEditing(false) }
  }

  const fmt = (n: number) => n.toLocaleString("id-ID")

  return (
    <tr className={`border-b border-cream-border/60 transition-colors ${isSelected ? "bg-brand-light/20" : "hover:bg-cream/30"}`}>
      <td className="pl-4 pr-2 py-3">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelect}
          className="rounded border-gray-300 text-brand focus:ring-brand/30 cursor-pointer"
        />
      </td>
      <td className="px-4 py-3 font-mono text-xs text-gray-500">{record.shippingId}</td>
      <td className="px-4 py-3 whitespace-nowrap">{record.event}</td>
      <td className="px-4 py-3 whitespace-nowrap">{record.customer}</td>
      <td className="px-4 py-3">
        <pre className="whitespace-pre-wrap font-sans text-xs text-gray-600 leading-relaxed max-w-[200px]">
          {record.invoicing}
        </pre>
      </td>
      <td className="px-4 py-3 text-right whitespace-nowrap">{record.weightEstimation} kg</td>
      <td className="px-4 py-3 text-right whitespace-nowrap">Rp {fmt(record.ongkirTotal)}</td>
      <td className="px-4 py-3">
        {record.isLastShipment ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
            Ya
          </span>
        ) : (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
            Tidak
          </span>
        )}
      </td>
      <td className="px-4 py-3 min-w-[180px]">
        {editing ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={saving}
                placeholder="Masukkan nomor resi"
                className="flex-1 min-w-0 border border-cream-border rounded-md px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-50"
              />
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="shrink-0 px-2 py-1 rounded-md bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
              >
                {saving ? "…" : "Simpan"}
              </button>
              <button
                type="button"
                onClick={() => { setValue(record.trackingNumber); setEditing(false) }}
                disabled={saving}
                className="shrink-0 px-2 py-1 rounded-md border border-cream-border text-gray-500 text-xs hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
              >
                Batal
              </button>
            </div>
            {saveError && <p className="text-xs text-red-500">{saveError}</p>}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="group flex items-center gap-1.5 text-left"
          >
            <span className={`text-xs ${record.trackingNumber ? "text-foreground font-mono" : "text-gray-400 italic"}`}>
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
        )}
      </td>
      <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap overflow-hidden">{record.createdAt}</td>
      <td className="px-2 py-3 text-center">
        <button
          type="button"
          onClick={() => setShowLabel(true)}
          title="Lihat label pengiriman"
          className="text-gray-400 hover:text-brand transition-colors"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
        {showLabel && (
          <LabelModal record={record} onClose={() => setShowLabel(false)} />
        )}
      </td>
    </tr>
  )
}
