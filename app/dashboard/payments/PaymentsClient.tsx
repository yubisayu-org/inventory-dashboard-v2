"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { PaymentRow } from "@/lib/db"
import { useResizableColumns } from "@/hooks/useResizableColumns"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import SearchableSelect from "@/components/SearchableSelect"

const ROWS_PER_PAGE = 20

const DINPUT =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const LABEL = "text-xs text-gray-500 mb-1 block"

type EditForm = {
  event: string
  customer: string
  amount: string
  account: string
  isChecked: boolean
  payDate: string
  remarks: string
}

function formatAmount(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n)
}

export default function PaymentsClient() {
  const options = useSheetOptions()
  const [rows, setRows] = useState<PaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [search, setSearch] = useState("")
  const [eventFilter, setEventFilter] = useState("")
  const [page, setPage] = useState(1)

  // Inline editing
  const [editingRow, setEditingRow] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<EditForm | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState("")

  // Add form
  const [addOpen, setAddOpen] = useState(false)

  const { widths, startResize } = useResizableColumns({
    index: 36, event: 110, customer: 130, amount: 100, account: 80,
    isChecked: 60, payDate: 90, remarks: 150, createdAt: 110, actions: 90,
  })

  const fetchRows = useCallback(() => {
    fetch("/api/sheets/payments")
      .then((r) => r.json())
      .then((data: { rows?: PaymentRow[]; error?: string }) => {
        if (data.error) throw new Error(data.error)
        setRows(data.rows ?? [])
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { fetchRows() }, [fetchRows])

  // Filters
  const events = useMemo(() => [...new Set(rows.map((r) => r.event))].sort(), [rows])

  const q = search.trim().toLowerCase()
  const filtered = useMemo(() => {
    let result = rows
    if (eventFilter) result = result.filter((r) => r.event === eventFilter)
    if (q) {
      result = result.filter(
        (r) =>
          r.event.toLowerCase().includes(q) ||
          r.customer.toLowerCase().includes(q) ||
          r.account.toLowerCase().includes(q) ||
          r.remarks.toLowerCase().includes(q) ||
          String(r.amount).includes(q),
      )
    }
    return result
  }, [rows, eventFilter, q])

  const totalPages = Math.max(1, Math.ceil(filtered.length / ROWS_PER_PAGE))
  const currentPage = Math.min(page, totalPages)
  const visible = filtered.slice((currentPage - 1) * ROWS_PER_PAGE, currentPage * ROWS_PER_PAGE)

  const hasFilters = Boolean(search || eventFilter)

  // Edit handlers
  function startEdit(row: PaymentRow) {
    setEditingRow(row.rowNumber)
    setEditForm({
      event: row.event,
      customer: row.customer,
      amount: String(row.amount),
      account: row.account,
      isChecked: row.isChecked,
      payDate: row.payDate,
      remarks: row.remarks,
    })
    setEditError("")
    if (addOpen) setAddOpen(false)
  }

  function cancelEdit() {
    setEditingRow(null)
    setEditForm(null)
    setEditError("")
  }

  async function saveEdit(rowNumber: number) {
    if (!editForm) return
    setEditSaving(true)
    setEditError("")
    try {
      const res = await fetch(`/api/sheets/payments/${rowNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: editForm.event,
          customer: editForm.customer,
          amount: Number(editForm.amount),
          account: editForm.account,
          isChecked: editForm.isChecked,
          payDate: editForm.payDate,
          remarks: editForm.remarks,
        }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to save")
      }
      setRows((prev) =>
        prev.map((r) =>
          r.rowNumber === rowNumber
            ? {
                ...r,
                event: editForm.event,
                customer: editForm.customer,
                amount: Number(editForm.amount),
                account: editForm.account,
                isChecked: editForm.isChecked,
                payDate: editForm.payDate,
                remarks: editForm.remarks,
              }
            : r,
        ),
      )
      cancelEdit()
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setEditSaving(false)
    }
  }

  async function handleDelete(rowNumber: number) {
    if (!confirm("Delete this payment? This cannot be undone.")) return
    try {
      const res = await fetch(`/api/sheets/payments/${rowNumber}`, { method: "DELETE" })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to delete")
      }
      if (editingRow === rowNumber) cancelEdit()
      setRows((prev) => prev.filter((r) => r.rowNumber !== rowNumber))
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  async function handleToggleCheck(row: PaymentRow) {
    const newChecked = !row.isChecked
    setRows((prev) =>
      prev.map((r) => (r.rowNumber === row.rowNumber ? { ...r, isChecked: newChecked } : r)),
    )
    try {
      const res = await fetch(`/api/sheets/payments/${row.rowNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: row.event,
          customer: row.customer,
          amount: row.amount,
          account: row.account,
          isChecked: newChecked,
          payDate: row.payDate,
          remarks: row.remarks,
        }),
      })
      if (!res.ok) throw new Error("Failed")
    } catch {
      setRows((prev) =>
        prev.map((r) => (r.rowNumber === row.rowNumber ? { ...r, isChecked: !newChecked } : r)),
      )
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-gray-400">
        Loading…
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-red-500">
        {error}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm min-w-[180px]">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            placeholder="Search customer, account, remarks…"
            className="w-full border border-cream-border rounded-lg pl-8 pr-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
          />
        </div>

        <select
          value={eventFilter}
          onChange={(e) => { setEventFilter(e.target.value); setPage(1) }}
          className="border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
        >
          <option value="">All Events</option>
          {events.map((ev) => <option key={ev} value={ev}>{ev}</option>)}
        </select>

        {hasFilters && (
          <button
            onClick={() => { setSearch(""); setEventFilter(""); setPage(1) }}
            className="text-xs text-gray-400 hover:text-brand transition-colors"
          >
            Reset
          </button>
        )}

        <span className="text-xs text-gray-400 shrink-0">
          {filtered.length} {filtered.length === 1 ? "row" : "rows"}
        </span>

        <div className="flex-1" />

        <button
          onClick={() => { setAddOpen((o) => !o); cancelEdit() }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-brand text-white hover:bg-brand-hover transition-colors shrink-0"
        >
          {addOpen ? "Cancel" : "+ Add Payment"}
        </button>
      </div>

      {/* Add form */}
      {addOpen && (
        <AddPaymentForm
          options={options}
          events={events}
          onClose={() => setAddOpen(false)}
          onAdded={() => { fetchRows(); setAddOpen(false) }}
        />
      )}

      {/* Table */}
      <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
        {filtered.length === 0 ? (
          <p className="px-5 py-8 text-sm text-gray-400 text-center">
            {hasFilters ? "No rows match your filters." : "No payment records yet."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
              <thead>
                <tr className="border-b border-cream-border text-left bg-cream">
                  {[
                    { key: "index", label: "#" },
                    { key: "event", label: "Event" },
                    { key: "customer", label: "Customer" },
                    { key: "amount", label: "Amount" },
                    { key: "account", label: "Account" },
                    { key: "isChecked", label: "✓" },
                    { key: "payDate", label: "Date" },
                    { key: "remarks", label: "Remarks" },
                    { key: "createdAt", label: "Created" },
                    { key: "actions", label: "" },
                  ].map((col) => (
                    <th
                      key={col.key}
                      className="px-4 py-3 text-xs font-medium text-gray-500 relative select-none"
                      style={{ width: widths[col.key as keyof typeof widths] }}
                    >
                      {col.label}
                      <div
                        onMouseDown={(e) => startResize(col.key, e)}
                        className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60"
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((row, i) => {
                  const isEditing = editingRow === row.rowNumber
                  return (
                    <tr
                      key={row.rowNumber}
                      className="border-b border-cream-border last:border-0 hover:bg-cream/50 transition-colors"
                    >
                      <td className="px-4 py-3 text-xs text-gray-400">
                        {(currentPage - 1) * ROWS_PER_PAGE + i + 1}
                      </td>

                      {isEditing && editForm ? (
                        <>
                          <td className="px-4 py-2">
                            <select value={editForm.event} onChange={(e) => setEditForm({ ...editForm, event: e.target.value })} className={DINPUT}>
                              <option value="">Select...</option>
                              {(options?.events ?? events).map((ev) => <option key={ev} value={ev}>{ev}</option>)}
                            </select>
                          </td>
                          <td className="px-4 py-2">
                            <SearchableSelect
                              value={editForm.customer}
                              onChange={(v) => setEditForm({ ...editForm, customer: v })}
                              options={(options?.customers ?? []).map((c) => ({ value: c, label: c }))}
                              placeholder="Customer..."
                              allowNewValue
                            />
                          </td>
                          <td className="px-4 py-2">
                            <input type="number" min="0" value={editForm.amount} onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })} className={DINPUT} style={{ width: "5rem" }} />
                          </td>
                          <td className="px-4 py-2">
                            <input type="text" value={editForm.account} onChange={(e) => setEditForm({ ...editForm, account: e.target.value })} className={DINPUT} style={{ width: "4rem" }} />
                          </td>
                          <td className="px-4 py-2 text-center">
                            <input type="checkbox" checked={editForm.isChecked} onChange={(e) => setEditForm({ ...editForm, isChecked: e.target.checked })} />
                          </td>
                          <td className="px-4 py-2">
                            <input type="text" value={editForm.payDate} onChange={(e) => setEditForm({ ...editForm, payDate: e.target.value })} placeholder="e.g. 20-Jan" className={DINPUT} style={{ width: "5rem" }} />
                          </td>
                          <td className="px-4 py-2">
                            <input type="text" value={editForm.remarks} onChange={(e) => setEditForm({ ...editForm, remarks: e.target.value })} placeholder="Optional" className={DINPUT} />
                          </td>
                          <td className="px-4 py-2" />
                          <td className="px-4 py-2">
                            <div className="flex flex-col items-end gap-1">
                              <div className="flex items-center gap-1.5">
                                <button onClick={() => saveEdit(row.rowNumber)} disabled={editSaving} className="text-xs text-brand font-medium hover:underline disabled:opacity-50">
                                  {editSaving ? "Saving…" : "Save"}
                                </button>
                                <button onClick={cancelEdit} className="text-xs text-gray-400 hover:underline">Cancel</button>
                                <button onClick={() => handleDelete(row.rowNumber)} title="Delete" className="p-1 text-gray-400 hover:text-red-500 transition-colors rounded">
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                                  </svg>
                                </button>
                              </div>
                              {editError && <p className="text-[11px] text-red-500 text-right">{editError}</p>}
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-4 py-3 text-foreground">{row.event}</td>
                          <td className="px-4 py-3 text-foreground">{row.customer}</td>
                          <td className="px-4 py-3 text-foreground text-right font-medium tabular-nums">
                            {formatAmount(row.amount)}
                          </td>
                          <td className="px-4 py-3 text-gray-500">{row.account || "—"}</td>
                          <td className="px-4 py-3 text-center">
                            <input
                              type="checkbox"
                              checked={row.isChecked}
                              onChange={() => handleToggleCheck(row)}
                              className="accent-brand cursor-pointer"
                            />
                          </td>
                          <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{row.payDate || "—"}</td>
                          <td className="px-4 py-3 text-gray-500 truncate" title={row.remarks}>{row.remarks || "—"}</td>
                          <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{row.createdAt}</td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => startEdit(row)}
                              className="text-xs text-brand font-medium hover:underline"
                            >
                              Edit
                            </button>
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            className="px-3 py-1.5 text-xs border border-cream-border rounded-lg text-gray-600 hover:bg-cream disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Previous
          </button>
          <span className="text-xs text-gray-400">
            Page {currentPage} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
            className="px-3 py-1.5 text-xs border border-cream-border rounded-lg text-gray-600 hover:bg-cream disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add Payment Form
// ---------------------------------------------------------------------------

function AddPaymentForm({
  options,
  events,
  onClose,
  onAdded,
}: {
  options: ReturnType<typeof useSheetOptions>
  events: string[]
  onClose: () => void
  onAdded: () => void
}) {
  const [event, setEvent] = useState("")
  const [customer, setCustomer] = useState("")
  const [amount, setAmount] = useState("")
  const [account, setAccount] = useState("BCA")
  const [isChecked, setIsChecked] = useState(true)
  const [payDate, setPayDate] = useState("")
  const [remarks, setRemarks] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null)

  const customerOptions = useMemo(
    () => (options?.customers ?? []).map((c) => ({ value: c, label: c })),
    [options],
  )

  const canSubmit = Boolean(event) && Boolean(customer) && Boolean(amount) && Number(amount) > 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setFeedback(null)
    try {
      const res = await fetch("/api/sheets/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, customer, amount: Number(amount), account, isChecked, payDate, remarks }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to save")
      }
      setFeedback({ type: "success", message: "Payment added" })
      onAdded()
    } catch (err) {
      setFeedback({ type: "error", message: err instanceof Error ? err.message : "Failed to save" })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-xl border border-cream-border bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-foreground">Add Payment</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-brand transition-colors p-0.5 rounded">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <form onSubmit={handleSubmit} className="flex items-end gap-3 flex-wrap">
        <div>
          <label className={LABEL}>Event <span className="text-brand">*</span></label>
          <select value={event} onChange={(e) => { setEvent(e.target.value); setFeedback(null) }} required className={DINPUT} style={{ width: "10rem" }}>
            <option value="">Select…</option>
            {(options?.events ?? events).map((ev) => <option key={ev} value={ev}>{ev}</option>)}
          </select>
        </div>
        <div>
          <label className={LABEL}>Customer <span className="text-brand">*</span></label>
          <div style={{ width: "10rem" }}>
            <SearchableSelect
              value={customer}
              onChange={(v) => { setCustomer(v); setFeedback(null) }}
              options={customerOptions}
              placeholder="Customer..."
              allowNewValue
            />
          </div>
        </div>
        <div>
          <label className={LABEL}>Amount <span className="text-brand">*</span></label>
          <input type="number" min="0" value={amount} onChange={(e) => { setAmount(e.target.value); setFeedback(null) }} placeholder="0" className={DINPUT} style={{ width: "7rem" }} />
        </div>
        <div>
          <label className={LABEL}>Account</label>
          <input type="text" value={account} onChange={(e) => setAccount(e.target.value)} className={DINPUT} style={{ width: "5rem" }} />
        </div>
        <div>
          <label className={LABEL}>Date</label>
          <input type="text" value={payDate} onChange={(e) => setPayDate(e.target.value)} placeholder="e.g. 20-Jan" className={DINPUT} style={{ width: "5rem" }} />
        </div>
        <div className="flex items-center gap-1.5 pb-2">
          <input type="checkbox" checked={isChecked} onChange={(e) => setIsChecked(e.target.checked)} id="add-checked" className="accent-brand" />
          <label htmlFor="add-checked" className="text-xs text-gray-500">Checked</label>
        </div>
        <div className="flex-1 min-w-[8rem]">
          <label className={LABEL}>Remarks</label>
          <input type="text" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional" className={DINPUT} />
        </div>
        <button
          type="submit"
          disabled={submitting || !canSubmit}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-brand text-white hover:bg-brand-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          {submitting ? "Saving…" : "Add"}
        </button>
      </form>
      {feedback && <p className={`text-xs mt-2 ${feedback.type === "success" ? "text-green-600" : "text-red-600"}`}>{feedback.message}</p>}
    </div>
  )
}
