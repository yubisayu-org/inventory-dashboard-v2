"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { OperationalExpenseRow, ExpenseCategory } from "@/lib/db/types"
import { EXPENSE_CATEGORIES } from "@/lib/db/types"
import DataGrid, {
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type PaginationState,
} from "@/components/DataGrid"
import { usePaginatedFetch, type PageData } from "@/hooks/usePaginatedFetch"
import SearchableSelect from "@/components/SearchableSelect"

const PAGE_SIZE = 25

/** An event plus the currency/kurs derived from its country (1 event = 1
 *  country). currency is "" and kurs 0 when the event has no country set. */
type EventOption = { name: string; currency: string; kurs: number }

const IDR = "IDR"

const fmt = (n: number) => n.toLocaleString("id-ID")

const formInputCls =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

const CATEGORY_BADGE: Record<ExpenseCategory, string> = {
  Flight: "bg-sky-50 text-sky-600",
  Lodging: "bg-violet-50 text-violet-600",
  Cargo: "bg-amber-50 text-amber-600",
  Meal: "bg-rose-50 text-rose-600",
  Transport: "bg-emerald-50 text-emerald-600",
  Shop: "bg-blue-50 text-blue-600",
  Supplies: "bg-teal-50 text-teal-600",
  Delivery: "bg-orange-50 text-orange-600",
  Personal: "bg-pink-50 text-pink-600",
  Payroll: "bg-indigo-50 text-indigo-600",
  Dividend: "bg-green-50 text-green-600",
  Other: "bg-gray-50 text-gray-600",
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function formatDate(iso: string): string {
  if (!iso) return "—"
  const d = new Date(iso + "T00:00:00")
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

/** round(foreign × rate), the default IDR amount. */
function calcIdr(foreign: number, rate: number): number {
  return Math.round((Number(foreign) || 0) * (Number(rate) || 0))
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-gray-500">{label}</span>
      {children}
    </label>
  )
}

function CategoryBadge({ category }: { category: ExpenseCategory }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${CATEGORY_BADGE[category] ?? "bg-gray-100 text-gray-500"}`}>
      {category}
    </span>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function OperationalExpensesClient() {
  const [data, setData] = useState<OperationalExpenseRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  // Full dropdown lists (event names + distinct methods) — load once from the
  // meta endpoint (a GET with no `page` param), like products' countries/stores.
  const [events, setEvents] = useState<EventOption[]>([])
  const [methods, setMethods] = useState<string[]>([])
  const [metaError, setMetaError] = useState<string | null>(null)

  const [sorting, setSorting] = useState<SortingState>([{ id: "id", desc: true }])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState("")
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE })

  const [mobileAddOpen, setMobileAddOpen] = useState(false)

  const loadMeta = useCallback(async () => {
    try {
      const res = await fetch("/api/sheets/operational-expenses")
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to load")
      setEvents(json.events as EventOption[])
      setMethods(json.methods as string[])
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : "Failed to load")
    }
  }, [])
  useEffect(() => { loadMeta() }, [loadMeta])

  // Server-filterable text columns → query params (event / category / method).
  const fetchFilters = useMemo<Record<string, string>>(() => {
    const f: Record<string, string> = {}
    for (const cf of columnFilters) {
      const v = String(cf.value ?? "").trim()
      if (!v) continue
      if (cf.id === "event") f.event = v
      else if (cf.id === "category") f.category = v
      else if (cf.id === "method") f.method = v
    }
    return f
  }, [columnFilters])

  const fetchSort = useMemo(() => {
    if (sorting.length === 0) return null
    return { key: sorting[0].id, direction: sorting[0].desc ? ("desc" as const) : ("asc" as const) }
  }, [sorting])

  const onData = useCallback((d: PageData) => {
    setData(d.rows as OperationalExpenseRow[])
    setTotalCount(d.totalCount)
  }, [])

  const { fetchState, refresh } = usePaginatedFetch({
    endpoint: "/api/sheets/operational-expenses",
    pageSize: PAGE_SIZE,
    page: pagination.pageIndex + 1,
    search: globalFilter,
    filters: fetchFilters,
    sort: fetchSort,
    onData,
  })

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // After a mutation: refetch the current page + the meta (a new method may have
  // appeared for the autocomplete).
  const reloadAll = useCallback(() => { refreshRef.current(); loadMeta() }, [loadMeta])

  // Reset to page 1 whenever the query shape (sort / filter / search) changes.
  const handleSortingChange = useCallback((u: SortingState | ((p: SortingState) => SortingState)) => {
    setSorting(u)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleColumnFiltersChange = useCallback((u: ColumnFiltersState | ((p: ColumnFiltersState) => ColumnFiltersState)) => {
    setColumnFilters(u)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])
  const handleGlobalFilterChange = useCallback((u: string | ((p: string) => string)) => {
    setGlobalFilter(u)
    setPagination((p) => ({ ...p, pageIndex: 0 }))
  }, [])

  const mobileIdDesc = (sorting.find((s) => s.id === "id")?.desc) ?? true

  const columns = useMemo<ColumnDef<OperationalExpenseRow, unknown>[]>(() => [
    { accessorKey: "id", header: "ID", enableColumnFilter: false, size: 60 },
    {
      accessorKey: "event",
      header: "Event",
      filterFn: "textContains",
      cell: ({ row }) => <span className="font-medium whitespace-nowrap">{row.original.event}</span>,
    },
    {
      accessorKey: "expenseDate",
      header: "Date",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="whitespace-nowrap text-gray-600">{formatDate(row.original.expenseDate)}</span>,
    },
    {
      accessorKey: "description",
      header: "Expenses",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="whitespace-nowrap">{row.original.description || "—"}</span>,
    },
    {
      accessorKey: "category",
      header: "Category",
      filterFn: "textContains",
      cell: ({ row }) => <CategoryBadge category={row.original.category} />,
    },
    {
      accessorKey: "amountForeign",
      header: "VLS",
      filterFn: "numeric",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="tabular-nums">{fmt(row.original.amountForeign)}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "rate",
      header: "Kurs",
      filterFn: "numeric",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="tabular-nums">{fmt(row.original.rate)}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "amountIdr",
      header: "IDR",
      filterFn: "numeric",
      enableColumnFilter: false,
      cell: ({ row }) => <span className="tabular-nums font-medium">{fmt(row.original.amountIdr)}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "isSettled",
      header: "Settle",
      enableColumnFilter: false,
      cell: ({ row }) => (
        <SettleToggle row={row.original} onToggled={() => refreshRef.current()} />
      ),
      meta: { align: "center" },
    },
    {
      accessorKey: "method",
      header: "Method",
      filterFn: "textContains",
      cell: ({ row }) => <span className="whitespace-nowrap text-gray-600">{row.original.method || "—"}</span>,
    },
    {
      accessorKey: "remarks",
      header: "Remarks",
      enableColumnFilter: false,
      enableSorting: false,
      cell: ({ row }) => <InlineRemarks row={row.original} onSaved={() => refreshRef.current()} />,
    },
    { accessorKey: "createdAt", header: "Created", enableColumnFilter: false },
    { accessorKey: "updatedAt", header: "Updated", enableColumnFilter: false },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableColumnFilter: false,
      enableHiding: false,
      cell: ({ row }) => (
        <ExpenseActions
          row={row.original}
          events={events}
          methods={methods}
          onUpdated={() => refreshRef.current()}
          onDeleted={() => refreshRef.current()}
        />
      ),
    },
  ], [events, methods])

  const refreshButton = (
    <button
      type="button"
      onClick={reloadAll}
      disabled={fetchState.loading}
      className="text-xs text-gray-500 hover:text-brand disabled:opacity-50 transition-colors px-3 py-1.5 rounded-lg border border-cream-border hover:border-brand"
    >
      {fetchState.loading ? "…" : "Refresh"}
    </button>
  )

  const errorMsg = fetchState.error || metaError

  return (
    <div className="flex flex-col gap-6">
      {/* Add form (desktop) */}
      <div className="hidden md:block">
        <AddExpenseForm events={events} methods={methods} onAdded={reloadAll} />
      </div>

      {errorMsg && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{errorMsg}</div>
      )}

      {/* Desktop table — server-side paginated */}
      <div className="hidden md:block">
        <DataGrid
          data={data}
          columns={columns}
          getRowId={(row) => String(row.rowNumber)}
          searchPlaceholder="Search event, expense, method, remarks…"
          toolbarExtra={refreshButton}
          initialVisibility={{ id: false, createdAt: false, updatedAt: false }}
          serverSide={{
            rowCount: totalCount,
            loading: fetchState.loading,
            sorting,
            onSortingChange: handleSortingChange,
            columnFilters,
            onColumnFiltersChange: handleColumnFiltersChange,
            globalFilter,
            onGlobalFilterChange: handleGlobalFilterChange,
            pagination,
            onPaginationChange: setPagination,
          }}
        />
      </div>

      {/* Mobile: search + sort + cards (server-driven) */}
      <div className="md:hidden flex flex-col gap-2.5">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
            <input
              value={globalFilter}
              onChange={(e) => handleGlobalFilterChange(e.target.value)}
              placeholder="Search expenses…"
              className="w-full border border-cream-border rounded-xl pl-9 pr-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
            />
          </div>
          <button
            type="button"
            onClick={() => handleSortingChange([{ id: "id", desc: !mobileIdDesc }])}
            aria-label="Toggle sort order"
            className="shrink-0 inline-flex items-center gap-1 px-3 rounded-xl border border-cream-border bg-white text-xs font-medium text-gray-600 active:border-brand active:text-brand"
          >
            {mobileIdDesc ? "Newest" : "Oldest"}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {mobileIdDesc ? <path d="m6 9 6 6 6-6" /> : <path d="m18 15-6-6-6 6" />}
            </svg>
          </button>
        </div>
        {data.length === 0 && (
          <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-gray-400">{fetchState.loading ? "Loading…" : "No expenses"}</div>
        )}
        {data.map((x) => (
          <div key={x.rowNumber} className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold text-foreground truncate">{x.description || "—"}</div>
                <div className="text-[12.5px] text-gray-400 mt-0.5">{x.event} · {formatDate(x.expenseDate)}</div>
              </div>
              <CategoryBadge category={x.category} />
            </div>
            <div className="flex items-center justify-between gap-3 mt-2.5 pt-2.5 border-t border-cream-border">
              <span className="text-xs text-gray-400 min-w-0 truncate">
                {x.rate !== 1 ? `${fmt(x.amountForeign)} × ${fmt(x.rate)}` : ""}{x.method ? ` · ${x.method}` : ""}
              </span>
              <div className="flex items-center gap-2.5 shrink-0">
                <SettleToggle row={x} onToggled={() => refreshRef.current()} />
                <span className="text-brand font-bold tabular-nums whitespace-nowrap">Rp {fmt(x.amountIdr)}</span>
                <ExpenseActions
                  row={x}
                  events={events}
                  methods={methods}
                  onUpdated={() => refreshRef.current()}
                  onDeleted={() => refreshRef.current()}
                />
              </div>
            </div>
          </div>
        ))}
        {totalCount > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-3 pt-1">
            <button type="button" disabled={pagination.pageIndex === 0} onClick={() => setPagination((p) => ({ ...p, pageIndex: p.pageIndex - 1 }))} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm text-gray-600 disabled:opacity-40">Prev</button>
            <span className="text-xs text-gray-400">Page {pagination.pageIndex + 1} of {Math.max(1, Math.ceil(totalCount / PAGE_SIZE))}</span>
            <button type="button" disabled={(pagination.pageIndex + 1) * PAGE_SIZE >= totalCount} onClick={() => setPagination((p) => ({ ...p, pageIndex: p.pageIndex + 1 }))} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm text-gray-600 disabled:opacity-40">Next</button>
          </div>
        )}
      </div>

      {/* Mobile add FAB */}
      <button
        type="button"
        onClick={() => setMobileAddOpen(true)}
        aria-label="Add expense"
        className="md:hidden fixed right-4 bottom-20 z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90"
      >
        +
      </button>

      {/* Mobile add sheet */}
      {mobileAddOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/40 flex flex-col justify-end" onClick={() => setMobileAddOpen(false)}>
          <div className="bg-cream rounded-t-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 sticky top-0 bg-cream/95 backdrop-blur z-10">
              <span className="font-semibold text-foreground">New Expense</span>
              <button type="button" onClick={() => setMobileAddOpen(false)} aria-label="Close" className="text-gray-400 p-1">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="px-3 pb-8">
              <AddExpenseForm events={events} methods={methods} onAdded={() => { setMobileAddOpen(false); reloadAll() }} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Settle toggle (quick PATCH) ─────────────────────────────────────────────

function SettleToggle({ row, onToggled }: { row: OperationalExpenseRow; onToggled: () => void }) {
  const [saving, setSaving] = useState(false)
  async function toggle() {
    setSaving(true)
    try {
      const res = await fetch(`/api/sheets/operational-expenses/${row.rowNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isSettled: !row.isSettled }),
      })
      if (!res.ok) throw new Error()
      onToggled()
    } catch {
      // Revert is implicit — the row keeps its old value until the next fetch.
    } finally {
      setSaving(false)
    }
  }
  return (
    <input
      type="checkbox"
      checked={row.isSettled}
      onChange={toggle}
      disabled={saving}
      aria-label="Settled"
      className="h-4 w-4 rounded border-cream-border text-brand accent-brand cursor-pointer disabled:opacity-50"
    />
  )
}

// ─── Inline remarks (PATCH on blur) ──────────────────────────────────────────

function InlineRemarks({ row, onSaved }: { row: OperationalExpenseRow; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(row.remarks)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])
  useEffect(() => { if (!editing) setValue(row.remarks) }, [row.remarks, editing])

  async function save() {
    setEditing(false)
    if (value.trim() === row.remarks) return
    try {
      const res = await fetch(`/api/sheets/operational-expenses/${row.rowNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remarks: value }),
      })
      if (!res.ok) throw new Error()
      onSaved()
    } catch {
      setValue(row.remarks)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save()
          else if (e.key === "Escape") { setValue(row.remarks); setEditing(false) }
        }}
        className="w-full border border-cream-border rounded-md px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
      />
    )
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit"
      className="text-left text-xs text-gray-500 hover:text-brand min-w-[3rem] truncate"
    >
      {row.remarks || <span className="text-gray-300">— add —</span>}
    </button>
  )
}

// ─── Add form ────────────────────────────────────────────────────────────────

const emptyDraft = () => ({
  event: "",
  expenseDate: todayIso(),
  description: "",
  category: "Flight" as ExpenseCategory,
  currency: IDR,
  amountForeign: "",
  rate: "1",
  amountIdr: "",
  isSettled: false,
  method: "",
})

function AddExpenseForm({
  events,
  methods,
  onAdded,
}: {
  events: EventOption[]
  methods: string[]
  onAdded: () => void
}) {
  const [draft, setDraft] = useState(emptyDraft)
  const [idrManual, setIdrManual] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const selectedEvent = events.find((e) => e.name === draft.event)
  const eventCurrency = selectedEvent?.currency || ""
  const eventKurs = selectedEvent?.kurs || 0
  const currencyOptions = eventCurrency ? [IDR, eventCurrency] : [IDR]
  const isIdr = draft.currency === IDR
  const effectiveRate = isIdr ? 1 : Number(draft.rate)

  const autoIdr = calcIdr(Number(draft.amountForeign), effectiveRate)
  const idrShown = idrManual ? draft.amountIdr : (draft.amountForeign ? String(autoIdr) : "")

  // Picking an event sets the default currency (its country's, else IDR) and the
  // starting kurs. Picking a currency flips between IDR (kurs locked at 1) and the
  // event's foreign currency (kurs pre-filled from the country, still editable).
  function pickEvent(name: string) {
    const ev = events.find((e) => e.name === name)
    const cur = ev?.currency || IDR
    setIdrManual(false)
    setDraft((d) => ({ ...d, event: name, currency: cur, rate: cur === IDR ? "1" : String(ev?.kurs || "") }))
  }
  function pickCurrency(cur: string) {
    setIdrManual(false)
    setDraft((d) => ({ ...d, currency: cur, rate: cur === IDR ? "1" : String(eventKurs || d.rate || "") }))
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!draft.event.trim()) { setAddError("Event is required"); return }
    setAdding(true)
    setAddError(null)
    try {
      const res = await fetch("/api/sheets/operational-expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: draft.event.trim(),
          expenseDate: draft.expenseDate,
          description: draft.description.trim(),
          category: draft.category,
          amountForeign: Number(draft.amountForeign) || 0,
          rate: effectiveRate || 0,
          amountIdr: Number(idrShown) || 0,
          isSettled: draft.isSettled,
          method: draft.method.trim(),
          remarks: "",
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to add")
      setDraft(emptyDraft())
      setIdrManual(false)
      onAdded()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add")
    } finally {
      setAdding(false)
    }
  }

  return (
    <form onSubmit={handleAdd} className="rounded-xl border border-cream-border bg-white p-5 flex flex-col gap-4">
      <span className="text-sm font-semibold text-foreground">Add Expense</span>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Event">
          <SearchableSelect
            value={draft.event}
            onChange={pickEvent}
            options={events.map((e) => ({ value: e.name, label: e.name, meta: e.currency || IDR }))}
            placeholder="Select event…"
            disabled={adding}
          />
        </Field>
        <Field label="Date">
          <input type="date" value={draft.expenseDate} onChange={(e) => setDraft((d) => ({ ...d, expenseDate: e.target.value }))} disabled={adding} className={formInputCls} />
        </Field>
        <Field label="Expenses">
          <input value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} placeholder="Vendor / description" disabled={adding} className={formInputCls} />
        </Field>
        <Field label="Category">
          <select value={draft.category} onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value as ExpenseCategory }))} disabled={adding} className={formInputCls}>
            {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Field label="Currency">
          <select value={draft.currency} onChange={(e) => pickCurrency(e.target.value)} disabled={adding} className={formInputCls}>
            {currencyOptions.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label={`Amount (${draft.currency})`}>
          <input value={draft.amountForeign} onChange={(e) => setDraft((d) => ({ ...d, amountForeign: e.target.value }))} type="number" step="any" min="0" placeholder="0" disabled={adding} className={formInputCls} />
        </Field>
        <Field label="Kurs">
          <input
            value={isIdr ? "1" : draft.rate}
            onChange={(e) => setDraft((d) => ({ ...d, rate: e.target.value }))}
            type="number" step="any" min="0" placeholder="1"
            disabled={adding || isIdr}
            title={isIdr ? "IDR expense — kurs is always 1" : "Pre-filled from the event's currency; adjust to the actual rate"}
            className={`${formInputCls} ${isIdr ? "bg-gray-50 text-gray-400" : ""}`}
          />
        </Field>
        <Field label="IDR">
          <input
            value={idrShown}
            onChange={(e) => { setIdrManual(true); setDraft((d) => ({ ...d, amountIdr: e.target.value })) }}
            type="number" min="0" placeholder="0" disabled={adding}
            className={formInputCls}
          />
        </Field>
        <Field label="Method">
          <SearchableSelect
            value={draft.method}
            onChange={(v) => setDraft((d) => ({ ...d, method: v }))}
            options={methods.map((m) => ({ value: m, label: m }))}
            placeholder="Method…"
            allowNewValue
            disabled={adding}
          />
        </Field>
      </div>

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={draft.isSettled} onChange={(e) => setDraft((d) => ({ ...d, isSettled: e.target.checked }))} disabled={adding} className="h-4 w-4 rounded border-cream-border accent-brand" />
          Settled
        </label>
        <div className="flex items-center gap-3">
          {addError && <p className="text-xs text-red-500">{addError}</p>}
          <button type="submit" disabled={adding} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors">
            {adding ? "Saving…" : "Add"}
          </button>
        </div>
      </div>
    </form>
  )
}

// ─── Actions (edit / delete) ─────────────────────────────────────────────────

function ExpenseActions({
  row,
  events,
  methods,
  onUpdated,
  onDeleted,
}: {
  row: OperationalExpenseRow
  events: EventOption[]
  methods: string[]
  onUpdated: () => void
  onDeleted: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  async function handleDelete() {
    if (!confirm(`Delete this expense (${row.description || row.event})?`)) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/sheets/operational-expenses/${row.rowNumber}`, { method: "DELETE" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onDeleted()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to delete")
    } finally {
      setDeleting(false)
    }
  }

  if (editing) {
    return (
      <EditExpenseModal
        row={row}
        events={events}
        methods={methods}
        onSave={() => { onUpdated(); setEditing(false) }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <div className="flex gap-2 items-center">
      <button type="button" onClick={() => { setSaveError(null); setEditing(true) }} title="Edit" className="text-gray-400 hover:text-brand transition-colors">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
        </svg>
      </button>
      <button type="button" onClick={handleDelete} disabled={deleting} title="Delete" className="text-gray-400 hover:text-red-500 disabled:opacity-50 transition-colors">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
      {saveError && <span className="text-xs text-red-500">{saveError}</span>}
    </div>
  )
}

// ─── Edit modal ──────────────────────────────────────────────────────────────

function EditExpenseModal({
  row,
  events,
  methods,
  onSave,
  onCancel,
}: {
  row: OperationalExpenseRow
  events: EventOption[]
  methods: string[]
  onSave: () => void
  onCancel: () => void
}) {
  // Infer the row's currency from its stored kurs: 1 = paid in IDR, otherwise the
  // event's foreign currency (or "FX" if the event has no country recorded).
  const rowForeign = events.find((e) => e.name === row.event)?.currency || (Number(row.rate) !== 1 ? "FX" : "")
  const [draft, setDraft] = useState({
    event: row.event,
    expenseDate: row.expenseDate,
    description: row.description,
    category: row.category,
    currency: Number(row.rate) === 1 ? IDR : (rowForeign || "FX"),
    amountForeign: String(row.amountForeign),
    rate: String(row.rate),
    amountIdr: String(row.amountIdr),
    isSettled: row.isSettled,
    method: row.method,
  })
  // Track whether the IDR field has diverged from the auto-calc, so editing
  // foreign/kurs re-derives it only while it still matches.
  const [idrManual, setIdrManual] = useState(
    row.amountIdr !== calcIdr(row.amountForeign, row.rate),
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const selectedEvent = events.find((e) => e.name === draft.event)
  const eventKurs = selectedEvent?.kurs || 0
  const foreignCurrency = selectedEvent?.currency || (draft.currency !== IDR ? draft.currency : "")
  const currencyOptions = foreignCurrency ? [IDR, foreignCurrency] : [IDR]
  const isIdr = draft.currency === IDR
  const effectiveRate = isIdr ? 1 : Number(draft.rate)

  const autoIdr = calcIdr(Number(draft.amountForeign), effectiveRate)
  const idrShown = idrManual ? draft.amountIdr : String(autoIdr)

  function pickEvent(name: string) {
    const ev = events.find((e) => e.name === name)
    const cur = ev?.currency || IDR
    setIdrManual(false)
    setDraft((d) => ({ ...d, event: name, currency: cur, rate: cur === IDR ? "1" : String(ev?.kurs || "") }))
  }
  function pickCurrency(cur: string) {
    setIdrManual(false)
    setDraft((d) => ({ ...d, currency: cur, rate: cur === IDR ? "1" : String(eventKurs || d.rate || "") }))
  }

  async function handleSave() {
    if (!draft.event.trim()) { setSaveError("Event is required"); return }
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(`/api/sheets/operational-expenses/${row.rowNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: draft.event.trim(),
          expenseDate: draft.expenseDate,
          description: draft.description.trim(),
          category: draft.category,
          amountForeign: Number(draft.amountForeign) || 0,
          rate: effectiveRate || 0,
          amountIdr: Number(idrShown) || 0,
          isSettled: draft.isSettled,
          method: draft.method.trim(),
          remarks: row.remarks,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onSave()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onCancel}>
      <div className="bg-white rounded-xl border border-cream-border shadow-xl p-6 w-full max-w-lg flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">Edit Expense</span>
          <span className="text-xs text-gray-400">ID: {row.rowNumber}</span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Event">
            <SearchableSelect
              value={draft.event}
              onChange={pickEvent}
              options={events.map((e) => ({ value: e.name, label: e.name, meta: e.currency || IDR }))}
              placeholder="Select event…"
              disabled={saving}
            />
          </Field>
          <Field label="Date">
            <input type="date" value={draft.expenseDate} onChange={(e) => setDraft((d) => ({ ...d, expenseDate: e.target.value }))} disabled={saving} className={formInputCls} />
          </Field>
          <Field label="Expenses">
            <input value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} disabled={saving} className={formInputCls} />
          </Field>
          <Field label="Category">
            <select value={draft.category} onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value as ExpenseCategory }))} disabled={saving} className={formInputCls}>
              {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Currency">
            <select value={draft.currency} onChange={(e) => pickCurrency(e.target.value)} disabled={saving} className={formInputCls}>
              {currencyOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label={`Amount (${draft.currency})`}>
            <input value={draft.amountForeign} onChange={(e) => setDraft((d) => ({ ...d, amountForeign: e.target.value }))} type="number" step="any" min="0" disabled={saving} className={formInputCls} />
          </Field>
          <Field label="Kurs">
            <input
              value={isIdr ? "1" : draft.rate}
              onChange={(e) => setDraft((d) => ({ ...d, rate: e.target.value }))}
              type="number" step="any" min="0"
              disabled={saving || isIdr}
              title={isIdr ? "IDR expense — kurs is always 1" : "Pre-filled from the event's currency; adjust to the actual rate"}
              className={`${formInputCls} ${isIdr ? "bg-gray-50 text-gray-400" : ""}`}
            />
          </Field>
          <Field label="IDR">
            <input
              value={idrShown}
              onChange={(e) => { setIdrManual(true); setDraft((d) => ({ ...d, amountIdr: e.target.value })) }}
              type="number" min="0" disabled={saving} className={formInputCls}
            />
          </Field>
          <Field label="Method">
            <SearchableSelect
              value={draft.method}
              onChange={(v) => setDraft((d) => ({ ...d, method: v }))}
              options={methods.map((m) => ({ value: m, label: m }))}
              placeholder="Method…"
              allowNewValue
              disabled={saving}
            />
          </Field>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-cream-border">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input type="checkbox" checked={draft.isSettled} onChange={(e) => setDraft((d) => ({ ...d, isSettled: e.target.checked }))} disabled={saving} className="h-4 w-4 rounded border-cream-border accent-brand" />
            Settled
          </label>
          <div className="flex items-center gap-2">
            {saveError && <p className="text-xs text-red-500">{saveError}</p>}
            <button type="button" onClick={onCancel} disabled={saving} className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-500 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
              Cancel
            </button>
            <button type="button" onClick={handleSave} disabled={saving} className="px-4 py-1.5 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
