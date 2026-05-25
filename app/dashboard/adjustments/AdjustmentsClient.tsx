"use client"

import { displayIg } from "@/lib/format"
import TableSkeleton from "@/components/TableSkeleton"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { AdjustmentRow } from "@/lib/db"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import SearchableSelect from "@/components/SearchableSelect"
import EventSelect from "@/components/EventSelect"
import DataGrid, { type ColumnDef } from "@/components/DataGrid"

const INPUT_CLASS =
  "w-full border border-cream-border rounded-md px-2 py-1 text-sm text-foreground bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const LABEL = "text-xs text-gray-500 mb-1 block"

const DEFAULT_DESCRIPTIONS = ["Free Shipping", "Shipping Difference"] as const

function descriptionOptions(extra: string[] = []) {
  const all = new Set<string>([...DEFAULT_DESCRIPTIONS, ...extra.filter(Boolean)])
  return Array.from(all).map((d) => ({ value: d, label: d }))
}

type EditForm = {
  event: string
  customer: string
  description: string
  amount: string
}

function formatAmount(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n)
}

export default function AdjustmentsClient() {
  const options = useSheetOptions()
  const [rows, setRows] = useState<AdjustmentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [addOpen, setAddOpen] = useState(false)
  const [editingRow, setEditingRow] = useState<AdjustmentRow | null>(null)

  const fetchRows = useCallback(() => {
    fetch("/api/sheets/adjustments")
      .then((r) => r.json())
      .then((data: { rows?: AdjustmentRow[]; error?: string }) => {
        if (data.error) throw new Error(data.error)
        setRows(data.rows ?? [])
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { fetchRows() }, [fetchRows])

  const columns = useMemo<ColumnDef<AdjustmentRow, unknown>[]>(() => [
    {
      accessorKey: "event",
      header: "Event",
      filterFn: "textContains",
    },
    {
      accessorKey: "customer",
      header: "Customer",
      filterFn: "textContains",
      cell: ({ getValue }) => <span>{displayIg(getValue<string>())}</span>,
    },
    {
      accessorKey: "description",
      header: "Description",
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const v = getValue<string>()
        return v || "—"
      },
    },
    {
      accessorKey: "amount",
      header: "Amount",
      filterFn: "numeric",
      meta: { align: "right" },
      cell: ({ getValue }) => {
        const n = getValue<number>()
        return (
          <span className={`font-medium tabular-nums ${n < 0 ? "text-red-500" : "text-foreground"}`}>
            {n < 0 ? `−${formatAmount(Math.abs(n))}` : formatAmount(n)}
          </span>
        )
      },
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      filterFn: "textContains",
      cell: ({ getValue }) => (
        <span className="text-gray-400 text-xs">{getValue<string>()}</span>
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
      enableColumnFilter: false,
      enableHiding: false,
      cell: ({ row }) => (
        <button
          onClick={() => setEditingRow(row.original)}
          className="text-xs text-brand font-medium hover:underline"
        >
          Edit
        </button>
      ),
    },
  ], [])

  function handleEditSaved(updated: AdjustmentRow) {
    setRows((prev) =>
      prev.map((r) => (r.rowNumber === updated.rowNumber ? updated : r)),
    )
    setEditingRow(null)
  }

  function handleDeleted(rowNumber: number) {
    setRows((prev) => prev.filter((r) => r.rowNumber !== rowNumber))
    setEditingRow(null)
  }

  if (loading) return <TableSkeleton />

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
        <AddAdjustmentForm
          options={options}
          onClose={() => setAddOpen(false)}
          onAdded={() => { fetchRows(); setAddOpen(false) }}
        />
      )}

      <DataGrid
        data={rows}
        columns={columns}
        pageSize={25}
        searchPlaceholder="Search adjustments..."
        getRowId={(row) => String(row.rowNumber)}
        initialVisibility={{ updatedAt: false }}
        toolbarExtra={
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
              Add Adjustment
            </button>
          </>
        }
      />

      {editingRow && (
        <EditAdjustmentModal
          row={editingRow}
          options={options}
          onClose={() => setEditingRow(null)}
          onSaved={handleEditSaved}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Edit Adjustment Modal
// ---------------------------------------------------------------------------

function EditAdjustmentModal({
  row,
  options,
  onClose,
  onSaved,
  onDeleted,
}: {
  row: AdjustmentRow
  options: ReturnType<typeof useSheetOptions>
  onClose: () => void
  onSaved: (updated: AdjustmentRow) => void
  onDeleted: (rowNumber: number) => void
}) {
  useModalDismiss(onClose)

  const [form, setForm] = useState<EditForm>({
    event: row.event,
    customer: row.customer,
    description: row.description,
    amount: String(row.amount),
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const customerOptions = useMemo(
    () => (options?.customers ?? []).map((c) => ({ value: c, label: displayIg(c) })),
    [options],
  )

  async function handleSave() {
    setSaving(true)
    setError("")
    try {
      const res = await fetch(`/api/sheets/adjustments/${row.rowNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: form.event,
          customer: form.customer,
          description: form.description,
          amount: Number(form.amount),
        }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to save")
      }
      onSaved({
        ...row,
        event: form.event,
        customer: form.customer,
        description: form.description,
        amount: Number(form.amount),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this adjustment? This cannot be undone.")) return
    try {
      const res = await fetch(`/api/sheets/adjustments/${row.rowNumber}`, { method: "DELETE" })
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-md p-5" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3 className="text-sm font-semibold text-foreground mb-4">Edit Adjustment</h3>

        <div className="space-y-3">
          <div>
            <label className={LABEL}>Event</label>
            <EventSelect value={form.event} onChange={(v) => setForm({ ...form, event: v })} events={options?.events ?? []} />
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
            <label className={LABEL}>Description</label>
            <SearchableSelect
              value={form.description}
              onChange={(v) => setForm({ ...form, description: v })}
              options={descriptionOptions([form.description])}
              placeholder="Select or type…"
              allowNewValue
            />
          </div>

          <div>
            <label className={LABEL}>Amount</label>
            <input
              type="number"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className={INPUT_CLASS}
            />
          </div>
        </div>

        {error && <p className="text-xs text-red-500 mt-2">{error}</p>}

        <div className="flex items-center justify-between mt-5">
          <button
            onClick={handleDelete}
            className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-red-500 transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
            </svg>
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
// Add Adjustment Form
// ---------------------------------------------------------------------------

function AddAdjustmentForm({
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
  const [description, setDescription] = useState("")
  const [amount, setAmount] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null)

  const customerOptions = useMemo(
    () => (options?.customers ?? []).map((c) => ({ value: c, label: displayIg(c) })),
    [options],
  )

  const canSubmit = Boolean(event) && Boolean(customer) && Boolean(amount) && Number(amount) !== 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setFeedback(null)
    try {
      const res = await fetch("/api/sheets/adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, customer, description, amount: Number(amount) }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error ?? "Failed to save")
      }
      setFeedback({ type: "success", message: "Adjustment added" })
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
        <h3 className="text-sm font-semibold text-foreground">Add Adjustment</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-brand transition-colors p-0.5 rounded">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <p className="text-xs text-gray-400 mb-3">Positive amount = extra charge, negative amount = discount</p>
      <form onSubmit={handleSubmit} className="flex items-end gap-3 flex-wrap">
        <div>
          <label className={LABEL}>Event <span className="text-brand">*</span></label>
          <div style={{ width: "10rem" }}>
            <EventSelect value={event} onChange={(v) => { setEvent(v); setFeedback(null) }} events={options?.events ?? []} />
          </div>
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
        <div className="flex-1 min-w-[10rem]">
          <label className={LABEL}>Description</label>
          <SearchableSelect
            value={description}
            onChange={(v) => { setDescription(v); setFeedback(null) }}
            options={descriptionOptions([description])}
            placeholder="Select or type…"
            allowNewValue
          />
        </div>
        <div>
          <label className={LABEL}>Amount <span className="text-brand">*</span></label>
          <input type="number" value={amount} onChange={(e) => { setAmount(e.target.value); setFeedback(null) }} placeholder="0" className={INPUT_CLASS} style={{ width: "7rem" }} />
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
