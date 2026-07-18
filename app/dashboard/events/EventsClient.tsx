"use client"

import TableSkeleton from "@/components/TableSkeleton"
import { useEffect, useMemo, useRef, useState } from "react"
import type { EventRow, WarehouseRow, CountryRow, EventPerformance } from "@/lib/db"
import DataGrid, { type ColumnDef } from "@/components/DataGrid"
import EventPerformancePanel from "./EventPerformancePanel"

const EMPTY_FORM = { name: "", eta: "", warehouseId: "", countryId: "" }

const formInputCls = "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const modalInputCls = "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-50"

export default function EventsClient() {
  const [data, setData] = useState<EventRow[] | null>(null)
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([])
  const [countries, setCountries] = useState<CountryRow[]>([])
  const [perfByName, setPerfByName] = useState<Map<string, EventPerformance>>(new Map())
  const [expandedMobile, setExpandedMobile] = useState<Record<number, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState(EMPTY_FORM)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const [editRow, setEditRow] = useState<EventRow | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [mobileAddOpen, setMobileAddOpen] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [evRes, whRes, coRes, perfRes] = await Promise.all([
        fetch("/api/sheets/events"),
        fetch("/api/sheets/warehouses"),
        fetch("/api/sheets/countries"),
        fetch("/api/sheets/events/performance"),
      ])
      const evJson = await evRes.json()
      if (!evRes.ok) throw new Error(evJson.error ?? "Failed to load events")
      const whJson = await whRes.json()
      if (!whRes.ok) throw new Error(whJson.error ?? "Failed to load warehouses")
      const coJson = await coRes.json()
      if (!coRes.ok) throw new Error(coJson.error ?? "Failed to load countries")
      const perfJson = await perfRes.json()
      if (!perfRes.ok) throw new Error(perfJson.error ?? "Failed to load event performance")
      setData(evJson.rows as EventRow[])
      setWarehouses(whJson.rows as WarehouseRow[])
      setCountries(coJson.rows as CountryRow[])
      setPerfByName(new Map((perfJson.rows as EventPerformance[]).map((p) => [p.name, p])))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // Default the add-form warehouse to the default warehouse once loaded.
  useEffect(() => {
    if (warehouses.length > 0 && !form.warehouseId) {
      const def = warehouses.find((w) => w.isDefault) ?? warehouses[0]
      setForm((f) => ({ ...f, warehouseId: String(def.id) }))
    }
  }, [warehouses, form.warehouseId])

  const warehouseById = useMemo(
    () => new Map(warehouses.map((w) => [w.id, w])),
    [warehouses],
  )

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setAdding(true)
    setAddError(null)
    try {
      const res = await fetch("/api/sheets/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          eta: form.eta.trim(),
          warehouseId: form.warehouseId ? Number(form.warehouseId) : null,
          countryId: form.countryId ? Number(form.countryId) : null,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to add")
      setForm({ ...EMPTY_FORM, warehouseId: form.warehouseId })
      setMobileAddOpen(false)
      load()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add")
    } finally {
      setAdding(false)
    }
  }

  function field(key: keyof typeof EMPTY_FORM) {
    return {
      value: form[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setForm((f) => ({ ...f, [key]: e.target.value })),
    }
  }

  async function handleDelete(row: EventRow) {
    if (!confirm(`Delete event "${row.name}"? Orders using this event will be affected.`)) return
    try {
      const res = await fetch(`/api/sheets/events/${row.id}`, { method: "DELETE" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      setData((prev) => prev?.filter((r) => r.id !== row.id) ?? null)
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  const columns = useMemo<ColumnDef<EventRow, unknown>[]>(() => [
    {
      accessorKey: "name",
      header: "Event Name",
      filterFn: "textContains",
      enableHiding: false,
      cell: ({ getValue }) => (
        <span className="font-medium">{getValue<string>()}</span>
      ),
    },
    {
      accessorKey: "eta",
      header: "ETA",
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const v = getValue<string>()
        return <span className={v ? "text-foreground" : "text-gray-400"}>{v || "—"}</span>
      },
    },
    {
      accessorKey: "warehouseId",
      header: "Gudang",
      filterFn: "textContains",
      cell: ({ getValue }) => {
        const wh = warehouseById.get(getValue<number>())
        return wh
          ? <span className="text-foreground">{wh.code}</span>
          : <span className="text-gray-400">—</span>
      },
    },
    {
      accessorKey: "countryName",
      header: "Country",
      filterFn: "textContains",
      cell: ({ row }) => {
        const { countryName, currency } = row.original
        return countryName
          ? <span className="text-foreground">{countryName} <span className="text-gray-400">({currency})</span></span>
          : <span className="text-gray-400">— IDR</span>
      },
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      enableColumnFilter: false,
      cell: ({ getValue }) => {
        const v = getValue<string | null>()
        return v ? <span className="text-gray-400 text-xs whitespace-nowrap">{v}</span> : ""
      },
    },
    {
      accessorKey: "updatedAt",
      header: "Updated",
      enableColumnFilter: false,
      cell: ({ getValue }) => {
        const v = getValue<string | null>()
        return v ? <span className="text-gray-400 text-xs whitespace-nowrap">{v}</span> : ""
      },
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableColumnFilter: false,
      enableHiding: false,
      size: 80,
      cell: ({ row }) => (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setEditRow(row.original)}
            title="Edit"
            className="text-gray-400 hover:text-brand transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => handleDelete(row.original)}
            title="Delete"
            className="text-gray-400 hover:text-red-500 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      ),
    },
  ], [warehouseById])


  const addForm = (
    <form onSubmit={handleAdd} className="hidden md:flex rounded-xl border border-cream-border bg-white p-5 flex-col gap-4">
      <div className="text-sm font-semibold text-foreground">Add Event</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <input
          {...field("name")}
          placeholder="Event name"
          required
          disabled={adding}
          className={formInputCls}
        />
        <input
          {...field("eta")}
          placeholder="ETA (e.g. 2026-06-15)"
          disabled={adding}
          className={formInputCls}
        />
        <select
          value={form.warehouseId}
          onChange={(e) => setForm((f) => ({ ...f, warehouseId: e.target.value }))}
          disabled={adding || warehouses.length === 0}
          className={formInputCls}
          aria-label="Gudang"
        >
          {warehouses.map((w) => (
            <option key={w.id} value={String(w.id)}>
              {w.name} ({w.code})
            </option>
          ))}
        </select>
        <select
          value={form.countryId}
          onChange={(e) => setForm((f) => ({ ...f, countryId: e.target.value }))}
          disabled={adding}
          className={formInputCls}
          aria-label="Country"
        >
          <option value="">No country (IDR)</option>
          {countries.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name} ({c.currency})
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center justify-end gap-3">
        {addError && <p className="text-xs text-red-500">{addError}</p>}
        <button
          type="submit"
          disabled={adding}
          className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
        >
          {adding ? "Saving…" : "Add"}
        </button>
      </div>
    </form>
  )

  return (
    <div className="flex flex-col gap-6">
      {/* Loading */}
      {loading && (
        <>
          <div className="hidden md:block"><TableSkeleton /></div>
          <div className="md:hidden rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-gray-400">Loading…</div>
        </>
      )}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {!loading && !error && data && (
        <>
          {/* Desktop table */}
          <div className="hidden md:block">
            <DataGrid
              data={data}
              columns={columns}
              pageSize={25}
              searchPlaceholder="Search events…"
              fullWidthSearch
              tightToolbar
              boldUppercaseHeader
              toolbarExtraAfterColumns
              hideRowCount
              belowToolbar={addOpen ? addForm : undefined}
              toolbarExtra={
                <button
                  type="button"
                  onClick={() => setAddOpen((o) => !o)}
                  className={`hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors ${
                    addOpen ? "bg-brand-light text-brand border border-brand/30" : "bg-brand text-white hover:bg-brand-hover"
                  }`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Add Event
                </button>
              }
              getRowId={(row) => String(row.id)}
              initialVisibility={{ createdAt: false, updatedAt: false }}
              initialSorting={[{ id: "name", desc: false }]}
              renderExpandedRow={(row) => <EventPerformancePanel perf={perfByName.get(row.name)} />}
            />
          </div>

          {/* Mobile cards */}
          <div className="md:hidden flex flex-col gap-2.5">
            {data.length === 0 && (
              <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-gray-400">No events yet</div>
            )}
            {data.map((ev) => {
              const isExpanded = Boolean(expandedMobile[ev.id])
              return (
              <div key={ev.id} className="rounded-xl border border-cream-border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                <div className="flex items-start justify-between gap-3 p-3.5">
                  <button
                    type="button"
                    onClick={() => setExpandedMobile((prev) => ({ ...prev, [ev.id]: !prev[ev.id] }))}
                    aria-expanded={isExpanded}
                    className="flex items-start gap-2 min-w-0 text-left"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`mt-0.5 shrink-0 text-gray-400 transition-transform ${isExpanded ? "rotate-90" : ""}`}><path d="m9 18 6-6-6-6" /></svg>
                    <span className="min-w-0">
                      <span className="block font-semibold text-foreground truncate">{ev.name}</span>
                      <span className={`block text-[12.5px] mt-0.5 ${ev.eta ? "text-gray-500" : "text-gray-400"}`}>
                        {ev.eta ? `ETA ${ev.eta}` : "No ETA"}
                        {ev.countryName ? ` · ${ev.countryName} (${ev.currency})` : " · IDR"}
                      </span>
                    </span>
                  </button>
                  <div className="flex gap-0.5 shrink-0">
                    <button type="button" onClick={() => setEditRow(ev)} aria-label="Edit" className="p-2 rounded-lg text-gray-400 active:bg-cream active:text-brand transition-colors">
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" /></svg>
                    </button>
                    <button type="button" onClick={() => handleDelete(ev)} aria-label="Delete" className="p-2 rounded-lg text-gray-400 active:bg-cream active:text-red-500 transition-colors">
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                    </button>
                  </div>
                </div>
                {isExpanded && (
                  <div className="border-t border-cream-border">
                    <EventPerformancePanel perf={perfByName.get(ev.name)} />
                  </div>
                )}
              </div>
              )
            })}
          </div>
        </>
      )}

      {/* Mobile add FAB */}
      <button
        type="button"
        onClick={() => setMobileAddOpen(true)}
        aria-label="Add event"
        className="md:hidden fixed right-4 bottom-20 z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90"
      >
        +
      </button>

      {/* Mobile add sheet */}
      {mobileAddOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex items-end bg-black/40" onClick={() => setMobileAddOpen(false)}>
          <form onSubmit={handleAdd} onClick={(e) => e.stopPropagation()} className="w-full bg-white rounded-t-2xl p-5 pb-8 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="text-base font-semibold text-foreground">Add Event</span>
              <button type="button" onClick={() => setMobileAddOpen(false)} aria-label="Close" className="text-gray-400 p-1">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <input {...field("name")} placeholder="Event name" required disabled={adding} className={modalInputCls} />
            <input {...field("eta")} placeholder="ETA (e.g. 2026-06-15)" disabled={adding} className={modalInputCls} />
            <select
              value={form.warehouseId}
              onChange={(e) => setForm((f) => ({ ...f, warehouseId: e.target.value }))}
              disabled={adding || warehouses.length === 0}
              className={modalInputCls}
              aria-label="Gudang"
            >
              {warehouses.map((w) => (
                <option key={w.id} value={String(w.id)}>{w.name} ({w.code})</option>
              ))}
            </select>
            <select
              value={form.countryId}
              onChange={(e) => setForm((f) => ({ ...f, countryId: e.target.value }))}
              disabled={adding}
              className={modalInputCls}
              aria-label="Country"
            >
              <option value="">No country (IDR)</option>
              {countries.map((c) => (
                <option key={c.id} value={String(c.id)}>{c.name} ({c.currency})</option>
              ))}
            </select>
            {addError && <p className="text-xs text-red-500">{addError}</p>}
            <button type="submit" disabled={adding} className="px-4 py-3 rounded-xl bg-brand text-white text-sm font-semibold disabled:opacity-50">
              {adding ? "Saving…" : "Save Event"}
            </button>
          </form>
        </div>
      )}

      {/* Edit modal */}
      {editRow && (
        <EditEventModal
          row={editRow}
          warehouses={warehouses}
          countries={countries}
          onSave={(updated) => {
            setData((prev) =>
              prev?.map((r) => r.id === editRow.id ? { ...r, ...updated } : r) ?? null
            )
            setEditRow(null)
          }}
          onCancel={() => setEditRow(null)}
        />
      )}
    </div>
  )
}

// ─── Edit modal ────────────────────────────────────────────────────────────

function EditEventModal({
  row,
  warehouses,
  countries,
  onSave,
  onCancel,
}: {
  row: EventRow
  warehouses: WarehouseRow[]
  countries: CountryRow[]
  onSave: (updated: Partial<EventRow>) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState({
    name: row.name,
    eta: row.eta,
    warehouseId: String(row.warehouseId),
    countryId: row.countryId != null ? String(row.countryId) : "",
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { firstInputRef.current?.focus() }, [])

  function draftField(key: keyof typeof draft) {
    return {
      value: draft[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setDraft((d) => ({ ...d, [key]: e.target.value })),
      disabled: saving,
    }
  }

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(`/api/sheets/events/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim(),
          eta: draft.eta.trim(),
          warehouseId: draft.warehouseId ? Number(draft.warehouseId) : null,
          countryId: draft.countryId ? Number(draft.countryId) : null,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      const selectedCountry = countries.find((c) => String(c.id) === draft.countryId)
      onSave({
        name: draft.name.trim(),
        eta: draft.eta.trim(),
        warehouseId: Number(draft.warehouseId),
        countryId: draft.countryId ? Number(draft.countryId) : null,
        countryName: selectedCountry?.name ?? "",
        currency: selectedCountry?.currency ?? "",
        kurs: selectedCountry?.kurs ?? 0,
      })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") { e.preventDefault(); handleSave() }
    if (e.key === "Escape") onCancel()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onCancel}>
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl p-6 w-full max-w-md flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">Edit Event</span>
          <span className="text-xs text-gray-400">ID: {row.id}</span>
        </div>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Event Name</span>
            <input
              ref={firstInputRef}
              {...draftField("name")}
              onKeyDown={handleKeyDown}
              placeholder="Event name"
              className={modalInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">ETA</span>
            <input
              {...draftField("eta")}
              onKeyDown={handleKeyDown}
              placeholder="ETA (e.g. 2026-06-15)"
              className={modalInputCls}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Gudang</span>
            <select
              value={draft.warehouseId}
              onChange={(e) => setDraft((d) => ({ ...d, warehouseId: e.target.value }))}
              disabled={saving || warehouses.length === 0}
              className={modalInputCls}
            >
              {warehouses.map((w) => (
                <option key={w.id} value={String(w.id)}>{w.name} ({w.code})</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Country (sets expense currency &amp; kurs)</span>
            <select
              value={draft.countryId}
              onChange={(e) => setDraft((d) => ({ ...d, countryId: e.target.value }))}
              disabled={saving}
              className={modalInputCls}
            >
              <option value="">No country (IDR)</option>
              {countries.map((c) => (
                <option key={c.id} value={String(c.id)}>{c.name} ({c.currency})</option>
              ))}
            </select>
          </label>
        </div>

        {saveError && <p className="text-xs text-red-500">{saveError}</p>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}
