"use client"

import { displayIg } from "@/lib/format"
import Link from "next/link"
import TableSkeleton from "@/components/TableSkeleton"
import InvoiceSummary from "@/components/InvoiceSummary"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { InvoiceEvent, InvoiceResult, RefundRow, RefundReason, RefundStatus } from "@/lib/db"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { fetchJson } from "@/lib/api-fetch"
import EventSelect from "@/components/EventSelect"

const INPUT_CLASS =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

const REASON_LABELS: Record<RefundReason, string> = {
  overpayment: "Overpayment",
  unavailable: "Item Unavailable",
  shipping_loss: "Lost in Shipping",
  damaged: "Damaged",
  goodwill: "Goodwill",
  other: "Other",
}

const STATUS_LABELS: Record<RefundStatus, string> = {
  pending: "Pending",
  awaiting_bank_info: "Awaiting Bank Info",
  ready_to_refund: "Ready to Refund",
  refunded: "Refunded",
  applied_to_next_order: "Applied to Next Order",
  cancelled: "Cancelled",
}

const STATUS_COLORS: Record<RefundStatus, string> = {
  pending: "bg-yellow-50 text-yellow-700 border-yellow-200",
  awaiting_bank_info: "bg-blue-50 text-blue-700 border-blue-200",
  ready_to_refund: "bg-orange-50 text-orange-700 border-orange-200",
  refunded: "bg-green-50 text-green-700 border-green-200",
  applied_to_next_order: "bg-purple-50 text-purple-700 border-purple-200",
  cancelled: "bg-gray-50 text-gray-500 border-gray-200",
}

const ACTIVE_TABS: { key: RefundStatus | "active"; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "awaiting_bank_info", label: "Awaiting Bank Info" },
  { key: "ready_to_refund", label: "Ready to Refund" },
  { key: "refunded", label: "Done" },
]

function formatRp(n: number) {
  return `Rp ${new Intl.NumberFormat("id-ID").format(n)}`
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function RefundsClient() {
  const options = useSheetOptions()
  const [rows, setRows] = useState<RefundRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [tab, setTab] = useState<RefundStatus>("pending")
  const [selectedEvent, setSelectedEvent] = useState("")
  const [search, setSearch] = useState("")
  const [creating, setCreating] = useState(false)
  const [editRow, setEditRow] = useState<RefundRow | null>(null)

  const fetchRows = useCallback(() => {
    setLoading(true)
    setError("")
    const params = new URLSearchParams()
    if (selectedEvent) params.set("event", selectedEvent)
    // GET /refunds auto-materializes overpayment refunds server-side, so
    // any detected overpayments appear in `rows` without further action.
    fetchJson<{ rows: RefundRow[] }>(`/api/sheets/refunds?${params}`)
      .then((data) => setRows(data.rows ?? []))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false))
  }, [selectedEvent])

  useEffect(() => { fetchRows() }, [fetchRows])

  const doneStatuses: RefundStatus[] = ["refunded", "applied_to_next_order", "cancelled"]

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return rows.filter((r) => {
      const matchTab = tab === "refunded" ? doneStatuses.includes(r.status) : r.status === tab
      const matchSearch = !q || r.customer.toLowerCase().includes(q) || r.event.toLowerCase().includes(q)
      return matchTab && matchSearch
    })
  }, [rows, tab, search])

  const counts = useMemo(() => {
    const c: Partial<Record<RefundStatus | "done", number>> = {}
    for (const r of rows) {
      c[r.status] = (c[r.status] ?? 0) + 1
    }
    const done = (c.refunded ?? 0) + (c.applied_to_next_order ?? 0) + (c.cancelled ?? 0)
    return { ...c, done }
  }, [rows])

  function handleUpdated(updated: RefundRow) {
    setRows((prev) => prev.map((r) => r.id === updated.id ? updated : r))
    setEditRow(null)
  }

  function handleCreated(created: RefundRow) {
    setRows((prev) => [created, ...prev])
    setCreating(false)
    setTab("pending")
  }

  function handleDeleted(id: number) {
    setRows((prev) => prev.filter((r) => r.id !== id))
    setEditRow(null)
  }

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customer or event…"
          className={`${INPUT_CLASS} flex-1 min-w-[180px]`}
        />
        <div style={{ width: "12rem" }}>
          <EventSelect
            value={selectedEvent}
            onChange={setSelectedEvent}
            events={options?.events ?? []}
            placeholder="All Events"
            clearable
          />
        </div>
        <button
          onClick={fetchRows}
          title="Refresh"
          className="p-1.5 text-gray-400 hover:text-brand transition-colors rounded"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-6.22-8.56" /><polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
        <button
          onClick={() => setCreating(true)}
          className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 transition-colors"
        >
          + New Refund
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-cream-border gap-0">
        {ACTIVE_TABS.map(({ key, label }) => {
          const count = key === "refunded" ? counts.done : counts[key as RefundStatus]
          const active = tab === key || (key === "refunded" && doneStatuses.includes(tab))
          return (
            <button
              key={key}
              onClick={() => setTab(key === "refunded" ? "refunded" : key as RefundStatus)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                active
                  ? "border-brand text-brand"
                  : "border-transparent text-gray-500 hover:text-foreground"
              }`}
            >
              {label}
              {count ? (
                <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full ${active ? "bg-brand/10 text-brand" : "bg-gray-100 text-gray-500"}`}>
                  {count}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
        {loading ? (
          <TableSkeleton />
        ) : error ? (
          <div className="py-8 px-4 text-sm text-red-500">{error}</div>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-cream-border bg-gray-50/80">
                <th className="text-left px-4 py-2.5 font-medium text-gray-500">Customer</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500">Event</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500">Reason</th>
                <th className="text-right px-4 py-2.5 font-medium text-gray-500">Amount</th>
                <th className="text-left px-4 py-2.5 font-medium text-gray-500">Status</th>
                <th className="px-4 py-2.5 w-16" />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-sm text-gray-400">
                    No refunds
                  </td>
                </tr>
              ) : filtered.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-cream-border hover:bg-gray-50/50 transition-colors cursor-pointer"
                  onClick={() => setEditRow(row)}
                >
                  <td className="px-4 py-3 font-medium text-foreground">{displayIg(row.customer)}</td>
                  <td className="px-4 py-3 text-gray-600">{row.event}</td>
                  <td className="px-4 py-3 text-gray-600">{REASON_LABELS[row.reason]}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold text-foreground">
                    {formatRp(row.refundAmount)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_COLORS[row.status]}`}>
                      {STATUS_LABELS[row.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={(e) => { e.stopPropagation(); setEditRow(row) }}
                      className="text-gray-400 hover:text-brand transition-colors"
                      title="Open"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <CreateRefundModal
          events={options?.events ?? []}
          onCreated={handleCreated}
          onClose={() => setCreating(false)}
        />
      )}

      {editRow && (
        <RefundDetailModal
          row={editRow}
          onUpdated={handleUpdated}
          onDeleted={() => handleDeleted(editRow.id)}
          onClose={() => setEditRow(null)}
        />
      )}
    </>
  )
}

// ─── Create refund modal ──────────────────────────────────────────────────────

function CreateRefundModal({
  events,
  onCreated,
  onClose,
}: {
  events: string[]
  onCreated: (row: RefundRow) => void
  onClose: () => void
}) {
  const [form, setForm] = useState({
    event: "",
    customer: "",
    reason: "overpayment" as RefundReason,
    refundAmount: "",
    note: "",
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function field<K extends keyof typeof form>(key: K) {
    return {
      value: form[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
        setForm((f) => ({ ...f, [key]: e.target.value })),
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
          event: form.event,
          customer: form.customer.trim(),
          reason: form.reason,
          refundAmount: Number(form.refundAmount),
          note: form.note.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to create")
      onCreated(data.row)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <form
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-md flex flex-col gap-4 p-6"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">New Refund</span>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-brand transition-colors">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Event</span>
            <EventSelect value={form.event} onChange={(v) => setForm((f) => ({ ...f, event: v }))} events={events} disabled={saving} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Customer (Instagram ID)</span>
            <input {...field("customer")} required disabled={saving} placeholder="@username" className={`${INPUT_CLASS} w-full`} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Reason</span>
            <select {...field("reason")} disabled={saving} className={`${INPUT_CLASS} w-full`}>
              {(Object.entries(REASON_LABELS) as [RefundReason, string][]).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Refund Amount (Rp)</span>
            <input
              {...field("refundAmount")}
              type="number"
              min="1"
              required
              disabled={saving}
              placeholder="e.g. 150000"
              className={`${INPUT_CLASS} w-full`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Note <span className="font-normal text-gray-400">(optional)</span></span>
            <textarea {...field("note")} disabled={saving} rows={2} placeholder="Additional context…" className={`${INPUT_CLASS} w-full resize-none`} />
          </label>
        </div>

        {error && <p className="text-xs text-red-500">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors">
            {saving ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  )
}

// ─── Refund detail modal ──────────────────────────────────────────────────────

function RefundDetailModal({
  row,
  onUpdated,
  onDeleted,
  onClose,
}: {
  row: RefundRow
  onUpdated: (updated: RefundRow) => void
  onDeleted: () => void
  onClose: () => void
}) {
  const [bankName, setBankName] = useState(row.bankName)
  const [bankAccountNumber, setBankAccountNumber] = useState(row.bankAccountNumber)
  const [bankAccountHolder, setBankAccountHolder] = useState(row.bankAccountHolder)
  const [transferRef, setTransferRef] = useState(row.transferReference)
  const [note, setNote] = useState(row.note)
  const [refundAmount, setRefundAmount] = useState(String(row.refundAmount))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const [invoiceEvent, setInvoiceEvent] = useState<InvoiceEvent | null>(null)
  const [invoiceLoading, setInvoiceLoading] = useState(true)
  const [invoiceError, setInvoiceError] = useState<string | null>(null)

  // Apply-as-credit flow: the customer's other orders are the valid targets.
  const [customerEvents, setCustomerEvents] = useState<InvoiceEvent[]>([])
  const [showCredit, setShowCredit] = useState(false)
  const [creditTarget, setCreditTarget] = useState("")

  useEffect(() => {
    let cancelled = false
    setInvoiceLoading(true)
    setInvoiceError(null)
    fetchJson<InvoiceResult>(`/api/sheets/invoice?customer=${encodeURIComponent(row.customer)}`)
      .then((data) => {
        if (cancelled) return
        setCustomerEvents(data.events)
        const match = data.events.find((ev) => ev.eventId === row.event) ?? null
        setInvoiceEvent(match)
        if (!match) setInvoiceError("No invoice found for this event")
      })
      .catch((err) => {
        if (!cancelled) setInvoiceError(err instanceof Error ? err.message : "Failed to load invoice")
      })
      .finally(() => { if (!cancelled) setInvoiceLoading(false) })
    return () => { cancelled = true }
  }, [row.customer, row.event])

  const isReadOnly = row.status === "refunded" || row.status === "cancelled" || row.status === "applied_to_next_order"

  async function patch(body: object) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/sheets/refunds/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      return false
    } finally {
      setSaving(false)
    }
  }

  async function handleStatusChange(status: RefundStatus) {
    const ok = await patch({ status })
    if (ok) onUpdated({ ...row, status })
  }

  async function handleApplyCredit() {
    if (!creditTarget) { setError("Pick a target order"); return }
    const ok = await patch({ action: "apply_credit", targetEvent: creditTarget })
    if (ok) onUpdated({ ...row, status: "applied_to_next_order", note: `Applied as credit to ${creditTarget}` })
  }

  // Reverses the credit's adjustments and reopens — for when it was applied to
  // the wrong order. (Plain status reopen would leave the money moved.)
  async function handleUndoCredit() {
    const ok = await patch({ action: "undo_credit" })
    if (ok) onUpdated({ ...row, status: "pending", note: "" })
  }

  async function handleSaveBankInfo() {
    const ok = await patch({ status: "ready_to_refund", bankName, bankAccountNumber, bankAccountHolder })
    if (!ok) return
    // Also update customer's bank info for future reuse
    await fetch("/api/sheets/customer", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instagramId: row.customer, bankName, bankAccountNumber, bankAccountHolder }),
    })
    onUpdated({ ...row, status: "ready_to_refund", bankName, bankAccountNumber, bankAccountHolder })
  }

  async function handleExecute() {
    if (!transferRef.trim()) { setError("Transfer reference is required"); return }
    const ok = await patch({ action: "execute", transferReference: transferRef.trim() })
    if (ok) onUpdated({ ...row, status: "refunded", transferReference: transferRef.trim() })
  }

  async function handleSaveNote() {
    const ok = await patch({ note, refundAmount: Number(refundAmount) })
    if (ok) onUpdated({ ...row, note, refundAmount: Number(refundAmount) })
  }

  async function handleDelete() {
    if (!confirm("Delete this refund? This cannot be undone.")) return
    setSaving(true)
    try {
      const res = await fetch(`/api/sheets/refunds/${row.id}`, { method: "DELETE" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to delete")
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete")
      setSaving(false)
    }
  }

  const waMessageText = `Halo ${row.customer} 👋\n\nKami ingin menginformasikan bahwa ada barang yang tidak tersedia dari sesi *${row.event}* sehingga perlu dilakukan pengembalian dana sebesar *${formatRp(row.refundAmount)}*.\n\nMohon balas pesan ini dengan informasi rekening bank:\n- Nama Bank:\n- Nomor Rekening:\n- Nama Pemilik Rekening:\n\nTerima kasih 🙏`
  const waMessage = encodeURIComponent(waMessageText)

  async function handleCopyMessage() {
    try {
      await navigator.clipboard.writeText(waMessageText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError("Failed to copy")
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-lg flex flex-col gap-0 overflow-hidden max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-start justify-between gap-3 px-6 py-4 border-b border-cream-border">
          <div>
            <div className="text-sm font-semibold text-foreground">{displayIg(row.customer)}</div>
            <div className="text-xs text-gray-400 mt-0.5">{row.event} · {REASON_LABELS[row.reason]}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_COLORS[row.status]}`}>
              {STATUS_LABELS[row.status]}
            </span>
            <button onClick={onClose} className="text-gray-400 hover:text-brand transition-colors">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        {/* Invoice that prompted this refund — pinned, always visible */}
        <div className="shrink-0 border-b border-cream-border">
          {invoiceLoading ? (
            <div className="px-6 py-3 text-xs text-gray-400">Loading invoice…</div>
          ) : invoiceError ? (
            <div className="px-6 py-3 text-xs text-red-500">{invoiceError}</div>
          ) : invoiceEvent ? (
            <InvoiceSummary
              event={invoiceEvent}
              actions={
                <Link
                  href={`/dashboard/invoice?customer=${encodeURIComponent(row.customer)}`}
                  className="text-xs px-2.5 py-1 rounded-lg border border-cream-border text-gray-600 hover:border-brand hover:text-brand transition-colors inline-flex items-center gap-1"
                >
                  Open full invoice
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M13 5l7 7-7 7" />
                  </svg>
                </Link>
              }
            />
          ) : null}
        </div>

        <div className="flex-1 min-h-0 flex flex-col gap-5 px-6 py-5 overflow-y-auto">
          {/* Amount + Note */}
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">Refund Amount (Rp)</span>
              {isReadOnly ? (
                <div className="text-lg font-bold text-foreground">{formatRp(row.refundAmount)}</div>
              ) : (
                <input
                  type="number"
                  min="1"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                  disabled={saving}
                  className={`${INPUT_CLASS} w-full`}
                />
              )}
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500">Note</span>
              {isReadOnly ? (
                <p className="text-sm text-gray-600">{row.note || "—"}</p>
              ) : (
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={saving}
                  rows={2}
                  className={`${INPUT_CLASS} w-full resize-none`}
                />
              )}
            </label>
            {!isReadOnly && (
              <div className="flex justify-end">
                <button onClick={handleSaveNote} disabled={saving} className="text-xs px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
                  Save
                </button>
              </div>
            )}
          </div>

          {/* WhatsApp message (pending / awaiting) */}
          {(row.status === "pending" || row.status === "awaiting_bank_info") && (
            <div className="flex flex-col gap-2 p-3 rounded-lg bg-green-50 border border-green-200">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-green-800">WhatsApp Message</div>
                <button
                  type="button"
                  onClick={handleCopyMessage}
                  title="Copy message"
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-green-300 text-green-700 hover:bg-green-100 transition-colors shrink-0"
                >
                  {copied ? (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                      Copied
                    </>
                  ) : (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      Copy
                    </>
                  )}
                </button>
              </div>
              <p className="text-xs text-green-700 whitespace-pre-wrap leading-relaxed">
                {waMessageText}
              </p>
              <div className="flex gap-2 flex-wrap">
                <a
                  href={`https://wa.me/?text=${waMessage}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors"
                >
                  Open in WhatsApp
                </a>
                {row.status === "pending" && (
                  <button
                    onClick={() => handleStatusChange("awaiting_bank_info")}
                    disabled={saving}
                    className="text-xs px-3 py-1.5 rounded-lg border border-green-300 text-green-700 hover:bg-green-100 disabled:opacity-50 transition-colors"
                  >
                    Mark message sent →
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Bank info form (awaiting / ready) */}
          {(row.status === "awaiting_bank_info" || row.status === "ready_to_refund") && (
            <div className="flex flex-col gap-3">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Bank Details</div>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Bank Name</span>
                <input
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  disabled={saving || row.status === "ready_to_refund"}
                  placeholder="e.g. BCA, Mandiri"
                  className={`${INPUT_CLASS} w-full`}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Account Number</span>
                <input
                  value={bankAccountNumber}
                  onChange={(e) => setBankAccountNumber(e.target.value)}
                  disabled={saving || row.status === "ready_to_refund"}
                  placeholder="e.g. 1234567890"
                  className={`${INPUT_CLASS} w-full`}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Account Holder Name</span>
                <input
                  value={bankAccountHolder}
                  onChange={(e) => setBankAccountHolder(e.target.value)}
                  disabled={saving || row.status === "ready_to_refund"}
                  placeholder="Full name on account"
                  className={`${INPUT_CLASS} w-full`}
                />
              </label>
              {row.status === "awaiting_bank_info" && (
                <div className="flex justify-end">
                  <button
                    onClick={handleSaveBankInfo}
                    disabled={saving || !bankName || !bankAccountNumber || !bankAccountHolder}
                    className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
                  >
                    {saving ? "Saving…" : "Save Bank Info →"}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Execute refund */}
          {row.status === "ready_to_refund" && (
            <div className="flex flex-col gap-3 p-3 rounded-lg bg-orange-50 border border-orange-200">
              <div className="text-xs font-semibold text-orange-800">Execute Transfer</div>
              <div className="text-xs text-orange-700">
                Transfer <span className="font-bold">{formatRp(row.refundAmount)}</span> to{" "}
                <span className="font-medium">{row.bankName}</span> · {row.bankAccountNumber} · {row.bankAccountHolder}
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-orange-800">Transfer Reference</span>
                <input
                  value={transferRef}
                  onChange={(e) => setTransferRef(e.target.value)}
                  disabled={saving}
                  placeholder="e.g. TRF20240510-001"
                  className={`${INPUT_CLASS} w-full`}
                />
              </label>
              <button
                onClick={handleExecute}
                disabled={saving || !transferRef.trim()}
                className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium hover:bg-orange-700 disabled:opacity-50 transition-colors"
              >
                {saving ? "Processing…" : "Mark as Refunded"}
              </button>
            </div>
          )}

          {/* Refunded — show summary */}
          {row.status === "refunded" && (
            <div className="flex flex-col gap-1.5 p-3 rounded-lg bg-green-50 border border-green-200 text-xs text-green-800">
              <div className="font-semibold">Transfer Complete</div>
              <div>Reference: <span className="font-medium">{row.transferReference || "—"}</span></div>
              <div>Bank: <span className="font-medium">{row.bankName} · {row.bankAccountNumber}</span></div>
              <div>Holder: <span className="font-medium">{row.bankAccountHolder}</span></div>
            </div>
          )}

          {/* Cancelled — nothing was moved, so a plain status reopen is safe */}
          {row.status === "cancelled" && (
            <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-gray-50 border border-gray-200">
              <div className="text-xs text-gray-600">
                This refund was cancelled.
                <br />
                <span className="text-gray-400">Pressed by mistake? Reopen to continue processing.</span>
              </div>
              <button
                type="button"
                onClick={() => handleStatusChange("pending")}
                disabled={saving}
                className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
              >
                ↩ Reopen
              </button>
            </div>
          )}

          {/* Applied as credit — undoing must REVERSE the adjustments, not just
              relabel, or the credit stays on the wrong order. */}
          {row.status === "applied_to_next_order" && (
            <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-purple-50 border border-purple-200">
              <div className="text-xs text-purple-700">
                {row.note || "Applied as credit to another order."}
                <br />
                <span className="text-purple-500">Wrong order? Undo to reverse the credit and reopen this refund.</span>
              </div>
              <button
                type="button"
                onClick={handleUndoCredit}
                disabled={saving}
                className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-purple-300 text-purple-700 hover:border-purple-500 hover:bg-purple-100 disabled:opacity-50 transition-colors"
              >
                {saving ? "Undoing…" : "↩ Undo credit"}
              </button>
            </div>
          )}

          {/* Apply as credit — pick which of the customer's other orders to credit */}
          {showCredit && !isReadOnly && (
            <div className="flex flex-col gap-3 p-3 rounded-lg bg-purple-50 border border-purple-200">
              <div className="text-xs font-semibold text-purple-800">Apply as Credit</div>
              <div className="text-xs text-purple-700">
                Apply <span className="font-bold">{formatRp(row.refundAmount)}</span> as credit to another order
                for <span className="font-medium">{displayIg(row.customer)}</span>. No cash is transferred — the
                overpayment is cleared here and the credit lowers what they owe on the chosen order.
              </div>
              {customerEvents.filter((ev) => ev.eventId !== row.event).length === 0 ? (
                <p className="text-xs text-purple-600">
                  This customer has no other orders to credit. Create their next order first, then apply the credit.
                </p>
              ) : (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-purple-800">Target order (event)</span>
                    <select
                      value={creditTarget}
                      onChange={(e) => setCreditTarget(e.target.value)}
                      disabled={saving}
                      className={`${INPUT_CLASS} w-full`}
                    >
                      <option value="">Select an order…</option>
                      {customerEvents
                        .filter((ev) => ev.eventId !== row.event)
                        .map((ev) => {
                          const owed = Math.max(0, ev.invoice.sisaPelunasan)
                          return (
                            <option key={ev.eventId} value={ev.eventId}>
                              {ev.eventId} — {owed > 0 ? `owes ${formatRp(owed)}` : "fully paid"}
                            </option>
                          )
                        })}
                    </select>
                  </label>
                  {(() => {
                    // Warn (but don't block) when the credit exceeds what the
                    // target owes: the excess would resurface as a fresh
                    // overpayment on that order rather than fully resolving here.
                    const tgt = customerEvents.find((ev) => ev.eventId === creditTarget)
                    if (!tgt) return null
                    const owed = Math.max(0, tgt.invoice.sisaPelunasan)
                    if (row.refundAmount <= owed) return null
                    const excess = row.refundAmount - owed
                    return (
                      <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2">
                        ⚠ This credit ({formatRp(row.refundAmount)}) is more than {tgt.eventId} owes ({formatRp(owed)}).
                        The extra <span className="font-semibold">{formatRp(excess)}</span> will resurface as a new
                        overpayment on {tgt.eventId} — no money is lost, but it won't fully clear here. You can refund
                        or re-apply the remainder afterward.
                      </p>
                    )
                  })()}
                  <div className="flex gap-2">
                    <button
                      onClick={handleApplyCredit}
                      disabled={saving || !creditTarget}
                      className="px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 disabled:opacity-50 transition-colors"
                    >
                      {saving ? "Applying…" : "Apply Credit"}
                    </button>
                    <button
                      onClick={() => { setShowCredit(false); setCreditTarget("") }}
                      disabled={saving}
                      className="px-3 py-2 rounded-lg border border-purple-200 text-purple-700 text-sm hover:bg-purple-100 disabled:opacity-50 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {error && <p className="shrink-0 text-xs text-red-500 px-6 pb-2">{error}</p>}
        {!isReadOnly && (
          <div className="shrink-0 flex items-center justify-between gap-2 px-6 py-4 border-t border-cream-border">
            <div className="flex gap-2">
              {row.status !== "cancelled" && row.status !== "applied_to_next_order" && (
                <>
                  <button
                    onClick={() => setShowCredit(true)}
                    disabled={saving}
                    className="text-xs px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 hover:border-purple-400 hover:text-purple-600 disabled:opacity-50 transition-colors"
                  >
                    Apply to Next Order
                  </button>
                  <button
                    onClick={() => handleStatusChange("cancelled")}
                    disabled={saving}
                    className="text-xs px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 hover:border-red-400 hover:text-red-500 disabled:opacity-50 transition-colors"
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
            <button
              onClick={handleDelete}
              disabled={saving}
              className="text-xs text-gray-400 hover:text-red-500 disabled:opacity-50 transition-colors"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
