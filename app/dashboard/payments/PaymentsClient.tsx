"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { PaymentRow } from "@/lib/db"
import { useResizableColumns } from "@/hooks/useResizableColumns"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import SearchableSelect from "@/components/SearchableSelect"
import { PaginationButton, PageJumpInput, getPageNumbers } from "@/components/Pagination"

const PAGE_SIZE = 25

const INPUT_CLASS =
  "w-full border border-cream-border rounded-md px-2 py-1 text-sm text-foreground bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const TOOLBAR_BTN =
  "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-cream-border rounded-lg hover:bg-cream transition-colors text-gray-600"
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

type SortKey = "event" | "customer" | "amount" | "payDate" | "createdAt"
type SortDir = "asc" | "desc"
type SortConfig = { key: SortKey; direction: SortDir } | null

const SORT_LABELS: Record<SortKey, string> = {
  event: "Event", customer: "Customer", amount: "Amount",
  payDate: "Date", createdAt: "Created At",
}

type Filters = { event: string; customer: string }

function formatAmount(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n)
}

function compareFn(a: PaymentRow, b: PaymentRow, key: SortKey, dir: SortDir): number {
  let cmp = 0
  switch (key) {
    case "amount":
      cmp = a.amount - b.amount
      break
    default:
      cmp = a[key].localeCompare(b[key])
  }
  return dir === "asc" ? cmp : -cmp
}

export default function PaymentsClient() {
  const options = useSheetOptions()
  const [rows, setRows] = useState<PaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [search, setSearch] = useState("")
  const [filters, setFilters] = useState<Filters>({ event: "", customer: "" })
  const [sort, setSort] = useState<SortConfig>(null)
  const [page, setPage] = useState(1)

  const [editingRow, setEditingRow] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<EditForm | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState("")
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

  const filterOptions = useMemo(() => ({
    events: [...new Set(rows.map((r) => r.event))].sort(),
    customers: [...new Set(rows.map((r) => r.customer))].sort(),
  }), [rows])

  const filtered = useMemo(() => {
    let result = rows
    if (filters.event) result = result.filter((r) => r.event === filters.event)
    if (filters.customer) result = result.filter((r) => r.customer === filters.customer)
    const q = search.trim().toLowerCase()
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
    if (sort) {
      result = [...result].sort((a, b) => compareFn(a, b, sort.key, sort.direction))
    }
    return result
  }, [rows, filters, search, sort])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  const activeFilterCount = Number(Boolean(filters.event)) + Number(Boolean(filters.customer))
  const hasActiveFilters = Boolean(search || activeFilterCount > 0)

  function setFilter(field: keyof Filters, value: string) {
    setFilters((f) => ({ ...f, [field]: value }))
    setPage(1)
  }
  function clearFilters() {
    setSearch("")
    setFilters({ event: "", customer: "" })
    setSort(null)
    setPage(1)
  }

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

      <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-cream-border">
          <div className="flex items-center gap-2">
            <div className="relative flex-1 max-w-xs">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1) }}
                placeholder="Search payments..."
                className="w-full pl-8 pr-3 py-1.5 text-xs border border-cream-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
              />
            </div>

            <FilterPopover filters={filters} filterOptions={filterOptions} activeCount={activeFilterCount} onSetFilter={setFilter} />
            <SortPopover sort={sort} onSetSort={setSort} />

            <div className="flex-1" />

            <span className="text-xs text-gray-400 shrink-0">
              {filtered.length} {filtered.length === 1 ? "row" : "rows"}
            </span>

            <button onClick={fetchRows} title="Refresh" className="p-1.5 text-gray-400 hover:text-brand transition-colors rounded">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-6.22-8.56" /><polyline points="21 3 21 9 15 9" />
              </svg>
            </button>

            <button
              onClick={() => { setAddOpen((o) => !o); cancelEdit() }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors ${
                addOpen ? "bg-brand-light text-brand border border-brand/30" : "bg-brand text-white hover:bg-brand-hover"
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Add Payment
            </button>
          </div>

          {hasActiveFilters && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
              {search           && <FilterChip label={`Search: "${search}"`}            onRemove={() => { setSearch(""); setPage(1) }} />}
              {filters.event    && <FilterChip label={`Event: ${filters.event}`}         onRemove={() => setFilter("event", "")} />}
              {filters.customer && <FilterChip label={`Customer: ${filters.customer}`}   onRemove={() => setFilter("customer", "")} />}
              <button onClick={clearFilters} className="text-xs text-gray-400 hover:text-brand transition-colors ml-1">Clear all</button>
            </div>
          )}
        </div>

        {filtered.length === 0 ? (
          <p className="px-5 py-8 text-sm text-gray-400 text-center">
            {hasActiveFilters ? "No rows match your filters." : "No payment records yet."}
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
                        {(currentPage - 1) * PAGE_SIZE + i + 1}
                      </td>

                      {isEditing && editForm ? (
                        <>
                          <td className="px-4 py-2">
                            <select value={editForm.event} onChange={(e) => setEditForm({ ...editForm, event: e.target.value })} className={INPUT_CLASS}>
                              <option value="">Select...</option>
                              {(options?.events ?? []).map((ev) => <option key={ev} value={ev}>{ev}</option>)}
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
                            <input type="number" min="0" value={editForm.amount} onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })} className={INPUT_CLASS} style={{ width: "5rem" }} />
                          </td>
                          <td className="px-4 py-2">
                            <input type="text" value={editForm.account} onChange={(e) => setEditForm({ ...editForm, account: e.target.value })} className={INPUT_CLASS} style={{ width: "4rem" }} />
                          </td>
                          <td className="px-4 py-2 text-center">
                            <input type="checkbox" checked={editForm.isChecked} onChange={(e) => setEditForm({ ...editForm, isChecked: e.target.checked })} />
                          </td>
                          <td className="px-4 py-2">
                            <input type="date" value={editForm.payDate} onChange={(e) => setEditForm({ ...editForm, payDate: e.target.value })} className={INPUT_CLASS} style={{ width: "9rem" }} />
                          </td>
                          <td className="px-4 py-2">
                            <input type="text" value={editForm.remarks} onChange={(e) => setEditForm({ ...editForm, remarks: e.target.value })} placeholder="Optional" className={INPUT_CLASS} />
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

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-cream-border">
            <div className="flex items-center gap-1.5 text-xs text-gray-400">
              <span>Page</span>
              <PageJumpInput
                currentPage={currentPage}
                totalPages={totalPages}
                onJump={(p) => setPage(p)}
              />
              <span>of {totalPages}</span>
            </div>
            <div className="flex items-center gap-1">
              <PaginationButton onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1}>&#8592;</PaginationButton>
              {getPageNumbers(currentPage, totalPages).map((p, idx) =>
                p === "…"
                  ? <span key={`e-${idx}`} className="px-2 text-xs text-gray-400">…</span>
                  : <PaginationButton key={p} onClick={() => setPage(p as number)} active={p === currentPage}>{p}</PaginationButton>
              )}
              <PaginationButton onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>&#8594;</PaginationButton>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toolbar popovers
// ---------------------------------------------------------------------------

function FilterPopover({ filters, filterOptions, activeCount, onSetFilter }: {
  filters: Filters
  filterOptions: { events: string[]; customers: string[] }
  activeCount: number
  onSetFilter: (field: keyof Filters, value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const fn = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener("mousedown", fn)
    return () => document.removeEventListener("mousedown", fn)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} className={TOOLBAR_BTN}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
        Filter
        {activeCount > 0 && <span className="ml-0.5 px-1.5 py-0.5 text-[10px] leading-none rounded-full bg-brand text-white font-medium">{activeCount}</span>}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-white border border-cream-border rounded-lg shadow-lg z-50 p-3 space-y-3">
          <div>
            <label className={LABEL}>Event</label>
            <SearchableSelect value={filters.event} onChange={(v) => onSetFilter("event", v)} options={filterOptions.events.map((v) => ({ value: v, label: v }))} placeholder="All Events" clearable />
          </div>
          <div>
            <label className={LABEL}>Customer</label>
            <SearchableSelect value={filters.customer} onChange={(v) => onSetFilter("customer", v)} options={filterOptions.customers.map((v) => ({ value: v, label: v }))} placeholder="All Customers" clearable />
          </div>
        </div>
      )}
    </div>
  )
}

function SortPopover({ sort, onSetSort }: { sort: SortConfig; onSetSort: (s: SortConfig) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const fn = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener("mousedown", fn)
    return () => document.removeEventListener("mousedown", fn)
  }, [open])

  const sortKeys: SortKey[] = ["event", "customer", "amount", "payDate", "createdAt"]

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} className={TOOLBAR_BTN}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m3 8 4-4 4 4" /><path d="M7 4v16" /><path d="M17 20V4" /><path d="m13 16 4 4 4-4" />
        </svg>
        {sort ? `${SORT_LABELS[sort.key]} ${sort.direction === "asc" ? "A→Z" : "Z→A"}` : "Sort"}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-white border border-cream-border rounded-lg shadow-lg z-50 p-3 space-y-3">
          <div>
            <label className={LABEL}>Column</label>
            <select
              value={sort?.key ?? ""}
              onChange={(e) => e.target.value ? onSetSort({ key: e.target.value as SortKey, direction: sort?.direction ?? "asc" }) : onSetSort(null)}
              className={INPUT_CLASS}
            >
              <option value="">None</option>
              {sortKeys.map((k) => <option key={k} value={k}>{SORT_LABELS[k]}</option>)}
            </select>
          </div>
          {sort && (
            <div>
              <label className="text-xs text-gray-500 mb-1.5 block">Direction</label>
              <div className="flex gap-2">
                {(["asc", "desc"] as const).map((dir) => (
                  <button key={dir} type="button" onClick={() => onSetSort({ key: sort.key, direction: dir })}
                    className={`flex-1 px-2 py-1.5 text-xs rounded-md border transition-colors ${sort.direction === dir ? "border-brand bg-brand-light text-brand font-medium" : "border-cream-border hover:bg-cream text-gray-600"}`}>
                    {sort.key === "amount" ? (dir === "asc" ? "1 → 9" : "9 → 1") : (dir === "asc" ? "A → Z" : "Z → A")}
                  </button>
                ))}
              </div>
            </div>
          )}
          {sort && (
            <button type="button" onClick={() => { onSetSort(null); setOpen(false) }} className="w-full text-xs text-gray-400 hover:text-brand transition-colors text-center pt-1">
              Remove sort
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filter Chip
// ---------------------------------------------------------------------------

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-cream border border-cream-border text-foreground">
      {label}
      <button type="button" onClick={onRemove} className="text-gray-400 hover:text-brand transition-colors ml-0.5">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </span>
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
