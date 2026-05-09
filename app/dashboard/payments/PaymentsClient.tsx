"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { PaymentRow } from "@/lib/db"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import SearchableSelect from "@/components/SearchableSelect"
import DataGrid, {
  numericFilter,
  textContainsFilter,
  booleanFilter,
  type ColumnDef,
} from "@/components/DataGrid"

const INPUT_CLASS =
  "w-full border border-cream-border rounded-md px-2 py-1 text-sm text-foreground bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
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

function formatDate(iso: string): string {
  if (!iso) return "—"
  const d = new Date(iso + "T00:00:00")
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

export default function PaymentsClient() {
  const options = useSheetOptions()
  const [rows, setRows] = useState<PaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [addOpen, setAddOpen] = useState(false)
  const [editingRow, setEditingRow] = useState<PaymentRow | null>(null)

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

  async function handleToggleCheck(row: PaymentRow) {
    const newChecked = !row.isChecked
    setRows((prev) =>
      prev.map((r) => (r.rowNumber === row.rowNumber ? { ...r, isChecked: newChecked } : r)),
    )
    try {
      const res = await fetch(`/api/sheets/payments/${row.rowNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isChecked: newChecked }),
      })
      if (!res.ok) throw new Error("Failed")
    } catch {
      setRows((prev) =>
        prev.map((r) => (r.rowNumber === row.rowNumber ? { ...r, isChecked: !newChecked } : r)),
      )
    }
  }

  const columns = useMemo<ColumnDef<PaymentRow, unknown>[]>(() => [
    {
      accessorKey: "event",
      header: "Event",
      filterFn: "textContains" as unknown as undefined,
    },
    {
      accessorKey: "customer",
      header: "Customer",
      filterFn: "textContains" as unknown as undefined,
    },
    {
      accessorKey: "amount",
      header: "Amount",
      filterFn: "numeric" as unknown as undefined,
      meta: { align: "right" },
      cell: ({ row }) => (
        <span className="tabular-nums font-medium">{formatAmount(row.original.amount)}</span>
      ),
    },
    {
      accessorKey: "account",
      header: "Account",
      filterFn: "textContains" as unknown as undefined,
      cell: ({ row }) => (
        <span className="text-gray-500">{row.original.account || "—"}</span>
      ),
    },
    {
      accessorKey: "isChecked",
      header: "✓",
      filterFn: "boolean" as unknown as undefined,
      enableSorting: false,
      size: 60,
      cell: ({ row }) => (
        <input
          type="checkbox"
          checked={row.original.isChecked}
          onChange={() => handleToggleCheck(row.original)}
          className="accent-brand cursor-pointer"
        />
      ),
    },
    {
      accessorKey: "payDate",
      header: "Date",
      filterFn: "textContains" as unknown as undefined,
      cell: ({ row }) => (
        <span className="text-gray-500 text-xs whitespace-nowrap">
          {formatDate(row.original.payDate)}
        </span>
      ),
    },
    {
      accessorKey: "remarks",
      header: "Remarks",
      filterFn: "textContains" as unknown as undefined,
      cell: ({ row }) => (
        <span className="text-gray-500 truncate block max-w-[200px]" title={row.original.remarks}>
          {row.original.remarks || "—"}
        </span>
      ),
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      filterFn: "textContains" as unknown as undefined,
      cell: ({ row }) => (
        <span className="text-gray-400 text-xs whitespace-nowrap">{row.original.createdAt}</span>
      ),
    },
    {
      accessorKey: "updatedAt",
      header: "Updated",
      enableHiding: true,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableHiding: false,
      size: 70,
      cell: ({ row }) => (
        <button
          onClick={() => setEditingRow(row.original)}
          className="text-xs text-brand font-medium hover:underline"
        >
          Edit
        </button>
      ),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [])

  const refreshButton = useMemo(() => (
    <>
      <button onClick={fetchRows} title="Refresh" className="p-1.5 text-gray-400 hover:text-brand transition-colors rounded">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-6.22-8.56" /><polyline points="21 3 21 9 15 9" />
        </svg>
      </button>
      <button
        onClick={() => { setAddOpen((o) => !o); setEditingRow(null) }}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors ${
          addOpen ? "bg-brand-light text-brand border border-brand/30" : "bg-brand text-white hover:bg-brand-hover"
        }`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        Add Payment
      </button>
    </>
  ), [addOpen, fetchRows])

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
      {addOpen && (
        <AddPaymentForm
          options={options}
          onClose={() => setAddOpen(false)}
          onAdded={() => { fetchRows(); setAddOpen(false) }}
        />
      )}

      <DataGrid
        data={rows}
        columns={columns}
        getRowId={(row) => String(row.rowNumber)}
        searchPlaceholder="Search payments..."
        toolbarExtra={refreshButton}
        initialVisibility={{ updatedAt: false }}
      />

      {editingRow && (
        <EditPaymentModal
          row={editingRow}
          options={options}
          onClose={() => setEditingRow(null)}
          onSaved={(updated) => {
            setRows((prev) =>
              prev.map((r) => (r.rowNumber === updated.rowNumber ? { ...r, ...updated } : r)),
            )
            setEditingRow(null)
          }}
          onDeleted={(rowNumber) => {
            setRows((prev) => prev.filter((r) => r.rowNumber !== rowNumber))
            setEditingRow(null)
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Edit Payment Modal
// ---------------------------------------------------------------------------

function EditPaymentModal({
  row,
  options,
  onClose,
  onSaved,
  onDeleted,
}: {
  row: PaymentRow
  options: ReturnType<typeof useSheetOptions>
  onClose: () => void
  onSaved: (updated: Partial<PaymentRow> & { rowNumber: number }) => void
  onDeleted: (rowNumber: number) => void
}) {
  const [form, setForm] = useState<EditForm>({
    event: row.event,
    customer: row.customer,
    amount: String(row.amount),
    account: row.account,
    isChecked: row.isChecked,
    payDate: row.payDate,
    remarks: row.remarks,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useModalDismiss(onClose)

  const customerOptions = useMemo(
    () => (options?.customers ?? []).map((c) => ({ value: c, label: c })),
    [options],
  )

  async function handleSave() {
    setSaving(true)
    setError("")
    try {
      const res = await fetch(`/api/sheets/payments/${row.rowNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: form.event,
          customer: form.customer,
          amount: Number(form.amount),
          account: form.account,
          isChecked: form.isChecked,
          payDate: form.payDate,
          remarks: form.remarks,
        }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to save")
      }
      onSaved({
        rowNumber: row.rowNumber,
        event: form.event,
        customer: form.customer,
        amount: Number(form.amount),
        account: form.account,
        isChecked: form.isChecked,
        payDate: form.payDate,
        remarks: form.remarks,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this payment? This cannot be undone.")) return
    try {
      const res = await fetch(`/api/sheets/payments/${row.rowNumber}`, { method: "DELETE" })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to delete")
      }
      onDeleted(row.rowNumber)
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-md flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-cream-border shrink-0 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Edit Payment</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-brand transition-colors p-0.5 rounded">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-3 overflow-y-auto">
          <div>
            <label className={LABEL}>Event</label>
            <select value={form.event} onChange={(e) => setForm({ ...form, event: e.target.value })} className={INPUT_CLASS}>
              <option value="">Select...</option>
              {(options?.events ?? []).map((ev) => <option key={ev} value={ev}>{ev}</option>)}
            </select>
          </div>
          <div>
            <label className={LABEL}>Customer</label>
            <SearchableSelect
              value={form.customer}
              onChange={(v) => setForm({ ...form, customer: v })}
              options={customerOptions}
              placeholder="Customer..."
              allowNewValue
            />
          </div>
          <div>
            <label className={LABEL}>Amount</label>
            <input type="number" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={INPUT_CLASS} />
          </div>
          <div>
            <label className={LABEL}>Account</label>
            <input type="text" value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })} className={INPUT_CLASS} />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={form.isChecked} onChange={(e) => setForm({ ...form, isChecked: e.target.checked })} id="edit-checked" className="accent-brand" />
            <label htmlFor="edit-checked" className="text-xs text-gray-500">Checked</label>
          </div>
          <div>
            <label className={LABEL}>Pay Date</label>
            <input type="date" value={form.payDate} onChange={(e) => setForm({ ...form, payDate: e.target.value })} className={INPUT_CLASS} />
          </div>
          <div>
            <label className={LABEL}>Remarks</label>
            <input type="text" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} placeholder="Optional" className={INPUT_CLASS} />
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="px-5 py-3 border-t border-cream-border shrink-0 flex items-center justify-between">
          <button onClick={handleDelete} className="text-xs text-red-500 hover:underline">
            Delete
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs text-gray-500 hover:text-foreground transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 text-xs font-medium rounded-lg bg-brand text-white hover:bg-brand-hover transition-colors disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add Payment Form
// ---------------------------------------------------------------------------

function AddPaymentForm({
  options,
  onClose,
  onAdded,
}: {
  options: ReturnType<typeof useSheetOptions>
  onClose: () => void
  onAdded: () => void
}) {
  const [event, setEvent] = useState("")
  const [customer, setCustomer] = useState("")
  const [amount, setAmount] = useState("")
  const [account, setAccount] = useState("BCA")
  const [isChecked, setIsChecked] = useState(true)
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10))
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
          <select value={event} onChange={(e) => { setEvent(e.target.value); setFeedback(null) }} required className={INPUT_CLASS} style={{ width: "10rem" }}>
            <option value="">Select…</option>
            {(options?.events ?? []).map((ev) => <option key={ev} value={ev}>{ev}</option>)}
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
          <input type="number" min="0" value={amount} onChange={(e) => { setAmount(e.target.value); setFeedback(null) }} placeholder="0" className={INPUT_CLASS} style={{ width: "7rem" }} />
        </div>
        <div>
          <label className={LABEL}>Account</label>
          <input type="text" value={account} onChange={(e) => setAccount(e.target.value)} className={INPUT_CLASS} style={{ width: "5rem" }} />
        </div>
        <div>
          <label className={LABEL}>Date</label>
          <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} className={INPUT_CLASS} style={{ width: "9rem" }} />
        </div>
        <div className="flex items-center gap-1.5 pb-2">
          <input type="checkbox" checked={isChecked} onChange={(e) => setIsChecked(e.target.checked)} id="add-checked" className="accent-brand" />
          <label htmlFor="add-checked" className="text-xs text-gray-500">Checked</label>
        </div>
        <div className="flex-1 min-w-[8rem]">
          <label className={LABEL}>Remarks</label>
          <input type="text" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional" className={INPUT_CLASS} />
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
