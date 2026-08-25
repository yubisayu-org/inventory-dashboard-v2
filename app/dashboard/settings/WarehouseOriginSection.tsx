"use client"

import { useEffect, useState, useRef } from "react"

// Where each warehouse ships FROM. Shipping rates are priced origin to
// destination, so nothing can be quoted for a warehouse without one — rate
// lookups fall back to the static jne_rates table until this is filled in.

interface Warehouse {
  id: number
  code: string
  name: string
  isDefault: boolean
  biteshipAreaId: string | null
  biteshipAreaName: string | null
  postalCode: string
}

interface Area {
  id: string
  name: string
  postalCode?: string
}

const inputCls =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

export default function WarehouseOriginSection() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [query, setQuery] = useState("")
  const [areas, setAreas] = useState<Area[]>([])
  const [chosen, setChosen] = useState<Area | null>(null)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const [adding, setAdding] = useState(false)
  const [newCode, setNewCode] = useState("")
  const [newName, setNewName] = useState("")
  const [addWarning, setAddWarning] = useState("")

  // Renaming the selected warehouse. Separate state from the add form so
  // opening one does not half-fill the other.
  const [editing, setEditing] = useState(false)
  const [editCode, setEditCode] = useState("")
  const [editName, setEditName] = useState("")

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Bumps per search so a slower earlier response cannot overwrite a newer one.
  const seq = useRef(0)

  async function load() {
    try {
      const res = await fetch("/api/warehouse-origin", { cache: "no-store" })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setWarehouses(data.warehouses)
      setSelectedId((prev) => prev ?? data.warehouses[0]?.id ?? null)
    } catch {
      setError("Couldn't load warehouses.")
    }
  }

  useEffect(() => {
    load()
  }, [])

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    const q = query.trim()
    if (q.length < 3) {
      setAreas([])
      setNotice("")
      return
    }
    // Each search is a billable Biteship request, so this waits longer than a
    // typical autocomplete would.
    debounce.current = setTimeout(async () => {
      const mine = ++seq.current
      try {
        const res = await fetch(`/api/biteship-areas?q=${encodeURIComponent(q)}`, { cache: "no-store" })
        const data = await res.json()
        if (mine !== seq.current) return
        if (res.status === 503 || data.notConfigured) {
          setAreas([])
          setNotice("BITESHIP_API_KEY is not set, so address search is inactive.")
          return
        }
        if (!res.ok) {
          setAreas([])
          setNotice(data.error ?? "Search failed.")
          return
        }
        setAreas(data.areas ?? [])
        setNotice((data.areas ?? []).length ? "" : "No matching area.")
      } catch {
        if (mine !== seq.current) return
        setAreas([])
        setNotice("Search is unavailable.")
      }
    }, 400)
  }, [query])

  const selected = warehouses.find((w) => w.id === selectedId) ?? null

  async function save() {
    if (!selected || !chosen) return
    setSaving(true)
    setError("")
    try {
      const res = await fetch("/api/warehouse-origin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          warehouseId: selected.id,
          biteshipAreaId: chosen.id,
          biteshipAreaName: chosen.name,
          postalCode: chosen.postalCode ?? "",
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? "Failed to save")
      }
      setSaved(true)
      setChosen(null)
      setQuery("")
      setAreas([])
      await load()
      setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  async function saveWarehouse() {
    if (!selected) return
    setError("")
    setAddWarning("")
    setSaving(true)
    try {
      const res = await fetch("/api/warehouse-origin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          warehouseId: selected.id,
          code: editCode.trim(),
          name: editName.trim(),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to save")
      await load()
      setEditing(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
      if (!data.hasRates) {
        // The FK cascades, so a rename normally keeps its rates. A code that
        // matches none means every ongkir from here prices at zero.
        setAddWarning(
          `No JNE rates exist for origin "${editCode.trim().toUpperCase()}". ` +
            "Shipping from this warehouse will price at zero until they do.",
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  async function addWarehouse() {
    const code = newCode.trim()
    const name = newName.trim()
    setError("")
    setAddWarning("")
    if (!code || !name) {
      setError("Code and name are both required.")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/warehouse-origin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", code, name }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Failed to add")
      await load()
      setSelectedId(data.id)
      setNewCode("")
      setNewName("")
      setAdding(false)
      if (!data.hasRates) {
        // Said out loud rather than discovered on an invoice: with no rate
        // rows and no origin, every customer's ongkir from here is 0.
        setAddWarning(
          `No JNE rates exist for origin "${code.toUpperCase()}". Until you set an origin below, ` +
            "shipping from this warehouse will price at zero.",
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-foreground">Warehouse shipping origin</h2>
        <div className="flex items-center gap-3">
          {saved && <span className="text-xs text-green-600">Saved</span>}
          <button
            type="button"
            onClick={() => { setAdding((v) => !v); setError(""); setAddWarning("") }}
            className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-xs font-medium hover:border-brand hover:text-brand transition-colors"
          >
            {adding ? "Cancel" : "+ Add warehouse"}
          </button>
        </div>
      </div>
      <p className="text-xs text-muted">
        Where each warehouse ships from. Rates are priced origin to destination, so a
        warehouse without one falls back to the JNE rate table.
      </p>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {addWarning && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {addWarning}
        </div>
      )}

      {adding && (
        <div className="rounded-lg border border-cream-border bg-cream p-3 flex flex-col gap-2">
          <label className="text-xs text-muted">Code — must match jne_rates.origin_code to price from the rate table</label>
          <input
            className={inputCls}
            value={newCode}
            onChange={(e) => setNewCode(e.target.value)}
            placeholder="JAKARTA"
            maxLength={20}
          />
          <label className="text-xs text-muted">Name</label>
          <input
            className={inputCls}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Jakarta"
            maxLength={80}
          />
          <button
            type="button"
            onClick={addWarehouse}
            disabled={saving}
            className="self-start px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {saving ? "Adding…" : "Add warehouse"}
          </button>
          <p className="text-xs text-muted">
            The default warehouse is not changed by adding one.
          </p>
        </div>
      )}

      <label className="text-xs text-muted">Warehouse</label>
      <select
        className={inputCls}
        value={selectedId ?? ""}
        onChange={(e) => {
          setSelectedId(Number(e.target.value))
          setChosen(null)
          setQuery("")
          setAreas([])
          setEditing(false)
        }}
      >
        {warehouses.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name} ({w.code}){w.isDefault ? " — default" : ""}
            {w.biteshipAreaId ? "" : " — no origin set"}
          </option>
        ))}
      </select>

      {selected && !editing && (
        <button
          type="button"
          onClick={() => {
            setEditing(true)
            setEditCode(selected.code)
            setEditName(selected.name)
            setError("")
            setAddWarning("")
          }}
          className="self-start text-xs font-medium text-brand hover:underline"
        >
          Rename this warehouse
        </button>
      )}

      {selected && editing && (
        <div className="rounded-lg border border-cream-border bg-cream p-3 flex flex-col gap-2">
          <label className="text-xs text-muted" htmlFor="wh-edit-code">
            Code — the JNE rate rows follow a rename, so nothing is orphaned
          </label>
          <input
            id="wh-edit-code"
            className={inputCls}
            value={editCode}
            onChange={(e) => setEditCode(e.target.value)}
            maxLength={20}
          />
          <label className="text-xs text-muted" htmlFor="wh-edit-name">Name</label>
          <input
            id="wh-edit-name"
            className={inputCls}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            maxLength={80}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={saveWarehouse}
              disabled={saving || !editCode.trim() || !editName.trim()}
              className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving…" : "Save warehouse"}
            </button>
            <button
              type="button"
              onClick={() => { setEditing(false); setError("") }}
              className="px-3 py-1.5 rounded-lg border border-cream-border text-muted-strong text-xs font-medium hover:border-brand hover:text-brand transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {selected && (
        <p className="text-xs text-muted">
          Current origin:{" "}
          {selected.biteshipAreaName ? (
            <span className="text-foreground font-medium">
              {selected.biteshipAreaName}
              {selected.postalCode ? ` · ${selected.postalCode}` : ""}
            </span>
          ) : (
            <span className="text-amber-700">not set — rates cannot be quoted from here</span>
          )}
        </p>
      )}

      <label className="text-xs text-muted">Search a new origin</label>
      <input
        className={inputCls}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="City or district, at least 3 letters"
      />

      {notice && <p className="text-xs text-amber-700">{notice}</p>}

      {areas.length > 0 && (
        <div className="border border-cream-border rounded-lg overflow-hidden max-h-48 overflow-y-auto">
          {areas.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                setChosen(a)
                setAreas([])
                setQuery("")
              }}
              className="w-full text-left px-3 py-2 text-sm border-b border-cream-border last:border-b-0 hover:bg-cream transition-colors"
            >
              {a.name}
            </button>
          ))}
        </div>
      )}

      {chosen && (
        <p className="rounded-lg bg-cream border border-cream-border px-3 py-2 text-sm">
          New origin: <span className="font-semibold text-brand">{chosen.name}</span>
        </p>
      )}

      <button
        type="button"
        onClick={save}
        disabled={!chosen || saving}
        className="self-start px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
      >
        {saving ? "Saving…" : "Save origin"}
      </button>
    </div>
  )
}
