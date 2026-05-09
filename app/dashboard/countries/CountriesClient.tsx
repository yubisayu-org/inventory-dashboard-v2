"use client"

import { useEffect, useRef, useState } from "react"
import type { CountryRow } from "@/lib/db"
import { useResizableColumns } from "@/hooks/useResizableColumns"

const EMPTY_FORM = { name: "", currency: "", kurs: "", cargoPerKg: "" }

const formInputCls = "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const rowInputCls = "w-full border border-cream-border rounded-md px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-50"

const fmt = (n: number) => n.toLocaleString("id-ID")

export default function CountriesClient() {
  const [data, setData] = useState<CountryRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState(EMPTY_FORM)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/countries")
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to load")
      setData(json.rows as CountryRow[])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const { widths, startResize } = useResizableColumns({
    name: 180,
    currency: 120,
    kurs: 140,
    cargoPerKg: 140,
    action: 80,
  })

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setAdding(true)
    setAddError(null)
    try {
      const res = await fetch("/api/sheets/countries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          currency: form.currency.trim(),
          kurs: Number(form.kurs) || 0,
          cargoPerKg: Number(form.cargoPerKg) || 0,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to add")
      setForm(EMPTY_FORM)
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

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={handleAdd} className="rounded-xl border border-cream-border bg-white p-5 flex flex-col gap-4">
        <div className="text-sm font-semibold text-foreground">Add Country</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <input
            {...field("name")}
            placeholder="Country name"
            required
            disabled={adding}
            className={formInputCls}
          />
          <input
            {...field("currency")}
            placeholder="Currency (e.g. CNY)"
            disabled={adding}
            className={formInputCls}
          />
          <input
            {...field("kurs")}
            type="number"
            min="0"
            placeholder="Kurs (IDR)"
            disabled={adding}
            className={formInputCls}
          />
          <input
            {...field("cargoPerKg")}
            type="number"
            min="0"
            placeholder="Cargo / kg (IDR)"
            disabled={adding}
            className={formInputCls}
          />
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

      <div className="flex justify-end">
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-xs text-gray-500 hover:text-brand disabled:opacity-50 transition-colors px-3 py-1.5 rounded-lg border border-cream-border hover:border-brand"
        >
          {loading ? "…" : "Refresh"}
        </button>
      </div>

      {loading && <div className="text-sm text-gray-400 py-12 text-center">Loading…</div>}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {!loading && !error && data?.length === 0 && (
        <div className="rounded-xl border border-cream-border bg-white p-12 text-center text-gray-400 text-sm">
          No countries yet.
        </div>
      )}
      {!loading && !error && data && data.length > 0 && (
        <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-cream-border bg-cream">
                  <th className="px-4 py-3 font-medium relative select-none" style={{ width: widths.name }}>
                    Country
                    <div onMouseDown={(e) => startResize("name", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                  <th className="px-4 py-3 font-medium relative select-none" style={{ width: widths.currency }}>
                    Currency
                    <div onMouseDown={(e) => startResize("currency", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                  <th className="px-4 py-3 font-medium text-right relative select-none" style={{ width: widths.kurs }}>
                    Kurs (IDR)
                    <div onMouseDown={(e) => startResize("kurs", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                  <th className="px-4 py-3 font-medium text-right relative select-none" style={{ width: widths.cargoPerKg }}>
                    Cargo / kg
                    <div onMouseDown={(e) => startResize("cargoPerKg", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                  <th className="px-4 py-3 font-medium relative select-none" style={{ width: widths.action }}>
                    <div onMouseDown={(e) => startResize("action", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <CountryRow
                    key={row.id}
                    row={row}
                    onUpdated={(updated) =>
                      setData((prev) =>
                        prev?.map((r) => r.id === row.id ? { ...r, ...updated } : r) ?? null
                      )
                    }
                    onDeleted={() =>
                      setData((prev) => prev?.filter((r) => r.id !== row.id) ?? null)
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function CountryRow({
  row,
  onUpdated,
  onDeleted,
}: {
  row: CountryRow
  onUpdated: (data: Partial<CountryRow>) => void
  onDeleted: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({
    name: row.name,
    currency: row.currency,
    kurs: String(row.kurs),
    cargoPerKg: String(row.cargoPerKg),
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const firstInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) firstInputRef.current?.focus()
  }, [editing])

  function startEdit() {
    setDraft({
      name: row.name,
      currency: row.currency,
      kurs: String(row.kurs),
      cargoPerKg: String(row.cargoPerKg),
    })
    setSaveError(null)
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
    setSaveError(null)
  }

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    const kurs = Number(draft.kurs) || 0
    const cargoPerKg = Number(draft.cargoPerKg) || 0
    try {
      const res = await fetch(`/api/sheets/countries/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim(),
          currency: draft.currency.trim(),
          kurs,
          cargoPerKg,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onUpdated({ name: draft.name.trim(), currency: draft.currency.trim(), kurs, cargoPerKg })
      setEditing(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete "${row.name}"? Products using this country will be affected.`)) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/sheets/countries/${row.id}`, { method: "DELETE" })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onDeleted()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to delete")
    } finally {
      setDeleting(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") { e.preventDefault(); handleSave() }
    if (e.key === "Escape") cancelEdit()
  }

  function draftField(key: keyof typeof draft) {
    return {
      value: draft[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setDraft((d) => ({ ...d, [key]: e.target.value })),
      onKeyDown: handleKeyDown,
      disabled: saving,
    }
  }

  return (
    <tr className="border-b border-cream-border/60 hover:bg-cream/30 transition-colors">
      {editing ? (
        <>
          <td className="px-3 py-2">
            <input ref={firstInputRef} {...draftField("name")} className={rowInputCls} placeholder="Country" />
          </td>
          <td className="px-3 py-2">
            <input {...draftField("currency")} className={rowInputCls} placeholder="Currency" />
          </td>
          <td className="px-3 py-2">
            <input {...draftField("kurs")} type="number" min="0" className={`${rowInputCls} text-right`} placeholder="Kurs" />
          </td>
          <td className="px-3 py-2">
            <input {...draftField("cargoPerKg")} type="number" min="0" className={`${rowInputCls} text-right`} placeholder="Cargo/kg" />
          </td>
          <td className="px-3 py-2">
            <div className="flex flex-col gap-1 items-end">
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="px-2 py-1 rounded-md bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
                >
                  {saving ? "…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={saving}
                  className="px-2 py-1 rounded-md border border-cream-border text-gray-500 text-xs hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
              {saveError && <p className="text-xs text-red-500 text-right">{saveError}</p>}
            </div>
          </td>
        </>
      ) : (
        <>
          <td className="px-4 py-3 font-medium">{row.name}</td>
          <td className="px-4 py-3 text-gray-600">{row.currency}</td>
          <td className="px-4 py-3 text-right tabular-nums font-medium">{fmt(row.kurs)}</td>
          <td className="px-4 py-3 text-right tabular-nums font-medium">{fmt(row.cargoPerKg)}</td>
          <td className="px-4 py-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={startEdit}
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
                onClick={handleDelete}
                disabled={deleting}
                title="Delete"
                className="text-gray-400 hover:text-red-500 disabled:opacity-50 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          </td>
        </>
      )}
    </tr>
  )
}
