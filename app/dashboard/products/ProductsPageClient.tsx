"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ProductRow, CountryRow } from "@/lib/db"
import { PaginationButton, PageJumpInput, getPageNumbers } from "@/components/Pagination"
import SearchableSelect from "@/components/SearchableSelect"

type PricingType = "abroad" | "domestic"

const PAGE_SIZE = 25

const formInputCls =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const rowInputCls =
  "w-full border border-cream-border rounded-md px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-50"

const fmt = (n: number) => n.toLocaleString("id-ID")

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-gray-500">{label}</span>
      {children}
    </label>
  )
}

function calcAbroadPrice(p: {
  valas: number; kurs: number; gram: number; cargoPerKg: number
  profitPct: number; operationalFee: number; packingFee: number
}) {
  const cogs = p.valas * p.kurs + (p.gram / 1000) * p.cargoPerKg
  if (p.profitPct >= 100) return { cogs, price: 0 }
  const raw = (cogs * 100) / (100 - p.profitPct) + p.operationalFee + p.packingFee
  return { cogs, price: Math.ceil(raw / 5000) * 5000 }
}

function calcDomesticPrice(cost: number, profitFixed: number) {
  return cost + profitFixed
}

function defaultDomesticProfit(cost: number): number {
  if (cost >= 800_000) return Math.round(cost * 0.15)
  if (cost >= 700_000) return 80_000
  if (cost > 498_000) return 55_000
  if (cost > 398_000) return 45_000
  if (cost > 298_000) return 35_000
  if (cost > 198_000) return 25_000
  if (cost > 98_000) return 20_000
  if (cost > 28_000) return 10_000
  return 5_000
}

function isAbroad(p: ProductRow) {
  return p.countryId != null
}

// ─── Main component ────────────────────────────────────────────────────────

export default function ProductsPageClient() {
  const [data, setData] = useState<ProductRow[] | null>(null)
  const [countries, setCountries] = useState<CountryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [tab, setTab] = useState<PricingType | "all">("all")
  const [searchQ, setSearchQ] = useState("")
  const [filterStore, setFilterStore] = useState("")
  const [filterCountry, setFilterCountry] = useState("")
  const [page, setPage] = useState(1)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/products")
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to load")
      setData(json.products as ProductRow[])
      setCountries(json.countries as CountryRow[])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const stores = useMemo(() => {
    if (!data) return []
    return [...new Set(data.map((r) => r.store).filter(Boolean))].sort()
  }, [data])

  const filtered = useMemo(() => {
    if (!data) return []
    let rows = data
    if (tab === "abroad") rows = rows.filter(isAbroad)
    else if (tab === "domestic") rows = rows.filter((p) => !isAbroad(p))
    if (searchQ) {
      const q = searchQ.toLowerCase()
      rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.store.toLowerCase().includes(q))
    }
    if (filterStore) rows = rows.filter((r) => r.store === filterStore)
    if (filterCountry) rows = rows.filter((r) => r.countryName === filterCountry)
    return rows
  }, [data, tab, searchQ, filterStore, filterCountry])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  useEffect(() => { setPage(1) }, [tab, searchQ, filterStore, filterCountry])

  return (
    <div className="flex flex-col gap-6">
      {/* Add form */}
      <AddProductForm
        countries={countries}
        stores={stores}
        onAdded={() => load()}
      />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Tabs */}
        <div className="flex rounded-lg border border-cream-border overflow-hidden text-sm">
          {(["all", "abroad", "domestic"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 capitalize transition-colors ${
                tab === t ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"
              }`}
            >
              {t === "all" ? `All (${data?.length ?? 0})` : t}
            </button>
          ))}
        </div>

        {/* Search */}
        <input
          type="text"
          placeholder="Search name or store…"
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
          className="border border-cream-border rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors w-56"
        />

        {/* Store filter */}
        <select
          value={filterStore}
          onChange={(e) => setFilterStore(e.target.value)}
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
        >
          <option value="">All stores</option>
          {stores.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        {/* Country filter */}
        {tab !== "domestic" && (
          <select
            value={filterCountry}
            onChange={(e) => setFilterCountry(e.target.value)}
            className="border border-cream-border rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
          >
            <option value="">All countries</option>
            {countries.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        )}

        <div className="flex-1" />

        <span className="text-xs text-gray-400">{filtered.length} products</span>

        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-xs text-gray-500 hover:text-brand disabled:opacity-50 transition-colors px-3 py-1.5 rounded-lg border border-cream-border hover:border-brand"
        >
          {loading ? "…" : "Refresh"}
        </button>
      </div>

      {/* Table */}
      {loading && <div className="text-sm text-gray-400 py-12 text-center">Loading…</div>}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {!loading && !error && filtered.length === 0 && (
        <div className="rounded-xl border border-cream-border bg-white p-12 text-center text-gray-400 text-sm">
          No products found.
        </div>
      )}
      {!loading && !error && pageRows.length > 0 && (
        <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ tableLayout: "auto" }}>
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-cream-border bg-cream">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Store</th>
                  <th className="px-4 py-3 font-medium text-right">Price</th>
                  <th className="px-4 py-3 font-medium text-center">Type</th>
                  <th className="px-4 py-3 font-medium">Country</th>
                  <th className="px-4 py-3 font-medium text-right">Valas</th>
                  <th className="px-4 py-3 font-medium text-right">Gram</th>
                  <th className="px-4 py-3 font-medium text-right">Kurs</th>
                  <th className="px-4 py-3 font-medium text-right">Cargo/kg</th>
                  <th className="px-4 py-3 font-medium text-right">%</th>
                  <th className="px-4 py-3 font-medium text-right">Op Fee</th>
                  <th className="px-4 py-3 font-medium text-right">Pack Fee</th>
                  <th className="px-4 py-3 font-medium text-right">Cost</th>
                  <th className="px-4 py-3 font-medium text-right">Profit</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => (
                  <ProductRowComp
                    key={row.id}
                    row={row}
                    countries={countries}
                    stores={stores}
                    onUpdated={(updated) =>
                      setData((prev) =>
                        prev?.map((r) => (r.id === row.id ? { ...r, ...updated } : r)) ?? null,
                      )
                    }
                    onDeleted={() => setData((prev) => prev?.filter((r) => r.id !== row.id) ?? null)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1.5 flex-wrap">
          <PaginationButton onClick={() => setPage(1)} disabled={safePage === 1}>«</PaginationButton>
          <PaginationButton onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage === 1}>‹</PaginationButton>
          {getPageNumbers(safePage, totalPages).map((n, i) =>
            n === "…" ? (
              <span key={`e${i}`} className="px-1 text-gray-400 text-xs">…</span>
            ) : (
              <PaginationButton key={n} onClick={() => setPage(n)} active={n === safePage}>{n}</PaginationButton>
            ),
          )}
          <PaginationButton onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}>›</PaginationButton>
          <PaginationButton onClick={() => setPage(totalPages)} disabled={safePage === totalPages}>»</PaginationButton>
          <PageJumpInput currentPage={safePage} totalPages={totalPages} onJump={setPage} />
          <span className="text-xs text-gray-400 ml-1">of {totalPages}</span>
        </div>
      )}
    </div>
  )
}

// ─── Add form ──────────────────────────────────────────────────────────────

function AddProductForm({
  countries,
  stores,
  onAdded,
}: {
  countries: CountryRow[]
  stores: string[]
  onAdded: () => void
}) {
  const [type, setType] = useState<PricingType>("abroad")
  const [name, setName] = useState("")
  const [store, setStore] = useState("")
  const [countryId, setCountryId] = useState<number | null>(countries[0]?.id ?? null)
  const [valas, setValas] = useState("")
  const [gram, setGram] = useState("")
  const [profitPct, setProfitPct] = useState("")
  const [opFee, setOpFee] = useState("5000")
  const [packFee, setPackFee] = useState("5000")
  const [cost, setCost] = useState("")
  const [profitFixed, setProfitFixed] = useState("")
  const [profitManual, setProfitManual] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  // Auto-fill kurs/cargo from selected country
  const selectedCountry = countries.find((c) => c.id === countryId)

  // Calculate price preview
  const pricePreview = useMemo(() => {
    if (type === "abroad") {
      const { cogs, price } = calcAbroadPrice({
        valas: Number(valas) || 0,
        kurs: selectedCountry?.kurs ?? 0,
        gram: Number(gram) || 0,
        cargoPerKg: selectedCountry?.cargoPerKg ?? 0,
        profitPct: Number(profitPct) || 0,
        operationalFee: Number(opFee) || 0,
        packingFee: Number(packFee) || 0,
      })
      return { cogs, price }
    }
    const price = calcDomesticPrice(Number(cost) || 0, Number(profitFixed) || 0)
    return { cogs: 0, price }
  }, [type, valas, gram, profitPct, opFee, packFee, cost, profitFixed, selectedCountry])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setAdding(true)
    setAddError(null)
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        store: store.trim(),
        price: pricePreview.price,
      }

      if (type === "abroad") {
        body.countryId = countryId
        body.valas = Number(valas) || 0
        body.gram = Number(gram) || 0
        body.kurs = selectedCountry?.kurs ?? 0
        body.cargoPerKg = selectedCountry?.cargoPerKg ?? 0
        body.profitPct = Number(profitPct) || 0
        body.operationalFee = Number(opFee) || 0
        body.packingFee = Number(packFee) || 0
      } else {
        body.cost = Number(cost) || 0
        body.profitFixed = Number(profitFixed) || 0
      }

      const res = await fetch("/api/sheets/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to add")

      // Reset
      setName("")
      setStore("")
      setValas("")
      setGram("")
      setProfitPct("")
      setCost("")
      setProfitFixed("")
      setProfitManual(false)
      onAdded()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add")
    } finally {
      setAdding(false)
    }
  }

  return (
    <form onSubmit={handleAdd} className="rounded-xl border border-cream-border bg-white p-5 flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <span className="text-sm font-semibold text-foreground">Add Product</span>
        <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setType("abroad")}
            className={`px-3 py-1 transition-colors ${type === "abroad" ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
          >
            Abroad
          </button>
          <button
            type="button"
            onClick={() => setType("domestic")}
            className={`px-3 py-1 transition-colors ${type === "domestic" ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
          >
            Domestic
          </button>
        </div>
      </div>

      {/* Common fields */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Product Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Product name" required disabled={adding} className={formInputCls} />
        </Field>
        <Field label="Store">
          <SearchableSelect
            value={store}
            onChange={setStore}
            options={stores.map((s) => ({ value: s, label: s }))}
            placeholder="Select or type store…"
            allowNewValue
            disabled={adding}
          />
        </Field>
      </div>

      {/* Abroad fields */}
      {type === "abroad" && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Country">
            <select
              value={countryId ?? ""}
              onChange={(e) => setCountryId(e.target.value ? Number(e.target.value) : null)}
              disabled={adding}
              className={formInputCls}
            >
              <option value="">Select country</option>
              {countries.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>
              ))}
            </select>
          </Field>
          <Field label="Valas">
            <input value={valas} onChange={(e) => setValas(e.target.value)} type="number" step="any" min="0" placeholder="0" disabled={adding} className={formInputCls} />
          </Field>
          <Field label="Gram">
            <input value={gram} onChange={(e) => setGram(e.target.value)} type="number" min="0" placeholder="0" disabled={adding} className={formInputCls} />
          </Field>
          <Field label="Profit %">
            <input value={profitPct} onChange={(e) => setProfitPct(e.target.value)} type="number" min="0" max="99" placeholder="0" disabled={adding} className={formInputCls} />
          </Field>
          <Field label="Operational Fee">
            <input value={opFee} onChange={(e) => setOpFee(e.target.value)} type="number" min="0" placeholder="5000" disabled={adding} className={formInputCls} />
          </Field>
          <Field label="Packing Fee">
            <input value={packFee} onChange={(e) => setPackFee(e.target.value)} type="number" min="0" placeholder="5000" disabled={adding} className={formInputCls} />
          </Field>

          {selectedCountry && (
            <div className="col-span-2 flex gap-4 text-xs text-gray-500 items-center">
              <span>Kurs: {fmt(selectedCountry.kurs)}</span>
              <span>Cargo/kg: {fmt(selectedCountry.cargoPerKg)}</span>
              <span>COGS: {fmt(Math.round(pricePreview.cogs))}</span>
            </div>
          )}
        </div>
      )}

      {/* Domestic fields */}
      {type === "domestic" && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Base Cost (IDR)">
            <input
              value={cost}
              onChange={(e) => {
                const v = e.target.value
                setCost(v)
                if (!profitManual) {
                  setProfitFixed(String(defaultDomesticProfit(Number(v) || 0)))
                }
              }}
              type="number" min="0" placeholder="0" disabled={adding} className={formInputCls}
            />
          </Field>
          <Field label="Fixed Profit (IDR)">
            <input
              value={profitFixed}
              onChange={(e) => { setProfitFixed(e.target.value); setProfitManual(true) }}
              type="number" min="0" placeholder="0" disabled={adding} className={formInputCls}
            />
          </Field>
        </div>
      )}

      {/* Price preview + submit */}
      <div className="flex items-center justify-between">
        <div className="text-sm">
          <span className="text-gray-500">Price: </span>
          <span className="font-semibold text-foreground">Rp {fmt(pricePreview.price)}</span>
        </div>
        <div className="flex items-center gap-3">
          {addError && <p className="text-xs text-red-500">{addError}</p>}
          <button
            type="submit"
            disabled={adding}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {adding ? "Saving…" : "Add"}
          </button>
        </div>
      </div>
    </form>
  )
}

// ─── Table row ─────────────────────────────────────────────────────────────

function ProductRowComp({
  row,
  countries,
  stores,
  onUpdated,
  onDeleted,
}: {
  row: ProductRow
  countries: CountryRow[]
  stores: string[]
  onUpdated: (data: Partial<ProductRow>) => void
  onDeleted: () => void
}) {
  const abroad = isAbroad(row)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({
    name: row.name,
    store: row.store,
    countryId: row.countryId,
    valas: String(row.valas),
    gram: String(row.gram),
    profitPct: String(row.profitPct),
    opFee: String(row.operationalFee),
    packFee: String(row.packingFee),
    cost: String(row.cost),
    profitFixed: String(row.profitFixed),
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const firstRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing) firstRef.current?.focus() }, [editing])

  function startEdit() {
    setDraft({
      name: row.name,
      store: row.store,
      countryId: row.countryId,
      valas: String(row.valas),
      gram: String(row.gram),
      profitPct: String(row.profitPct),
      opFee: String(row.operationalFee),
      packFee: String(row.packingFee),
      cost: String(row.cost),
      profitFixed: String(row.profitFixed),
    })
    setSaveError(null)
    setEditing(true)
  }

  const draftCountry = countries.find((c) => c.id === draft.countryId)
  const draftAbroad = draft.countryId != null

  const editPrice = useMemo(() => {
    if (draftAbroad) {
      const { price } = calcAbroadPrice({
        valas: Number(draft.valas) || 0,
        kurs: draftCountry?.kurs ?? row.kurs,
        gram: Number(draft.gram) || 0,
        cargoPerKg: draftCountry?.cargoPerKg ?? row.cargoPerKg,
        profitPct: Number(draft.profitPct) || 0,
        operationalFee: Number(draft.opFee) || 0,
        packingFee: Number(draft.packFee) || 0,
      })
      return price
    }
    return calcDomesticPrice(Number(draft.cost) || 0, Number(draft.profitFixed) || 0)
  }, [draft, draftAbroad, draftCountry, row.kurs, row.cargoPerKg])

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    try {
      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        store: draft.store.trim(),
        price: editPrice,
        gram: Number(draft.gram) || 0,
        countryId: draft.countryId,
        valas: draftAbroad ? Number(draft.valas) || 0 : 0,
        kurs: draftAbroad ? (draftCountry?.kurs ?? row.kurs) : 0,
        cargoPerKg: draftAbroad ? (draftCountry?.cargoPerKg ?? row.cargoPerKg) : 0,
        profitPct: draftAbroad ? Number(draft.profitPct) || 0 : 0,
        operationalFee: draftAbroad ? Number(draft.opFee) || 0 : 5000,
        packingFee: draftAbroad ? Number(draft.packFee) || 0 : 5000,
        cost: draftAbroad ? 0 : Number(draft.cost) || 0,
        profitFixed: draftAbroad ? 0 : Number(draft.profitFixed) || 0,
      }

      const res = await fetch(`/api/sheets/products/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")

      onUpdated({
        name: draft.name.trim(),
        store: draft.store.trim(),
        price: editPrice,
        gram: Number(draft.gram) || 0,
        countryId: draft.countryId,
        countryName: draftCountry?.name ?? "",
        valas: Number(body.valas) || 0,
        kurs: Number(body.kurs) || 0,
        cargoPerKg: Number(body.cargoPerKg) || 0,
        profitPct: Number(body.profitPct) || 0,
        operationalFee: Number(body.operationalFee) || 0,
        packingFee: Number(body.packingFee) || 0,
        cost: Number(body.cost) || 0,
        profitFixed: Number(body.profitFixed) || 0,
      })
      setEditing(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete "${row.name}"?`)) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/sheets/products/${row.id}`, { method: "DELETE" })
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
    if (e.key === "Escape") { setEditing(false); setSaveError(null) }
  }

  if (editing) {
    return (
      <tr className="border-b border-cream-border/60 bg-cream/20">
        <td className="px-3 py-2">
          <input ref={firstRef} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} onKeyDown={handleKeyDown} disabled={saving} className={rowInputCls} />
        </td>
        <td className="px-3 py-2">
          <SearchableSelect
            value={draft.store}
            onChange={(v) => setDraft((d) => ({ ...d, store: v }))}
            options={stores.map((s) => ({ value: s, label: s }))}
            placeholder="Store…"
            allowNewValue
            disabled={saving}
          />
        </td>
        <td className="px-3 py-2 text-right text-xs font-medium tabular-nums">{fmt(editPrice)}</td>
        <td className="px-3 py-2 text-center">
          <select
            value={draft.countryId ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, countryId: e.target.value ? Number(e.target.value) : null }))}
            disabled={saving}
            className={`${rowInputCls} text-center`}
          >
            <option value="">Domestic</option>
            {countries.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </td>
        <td className="px-3 py-2 text-xs text-gray-400">{draftCountry?.name ?? "—"}</td>
        <td className="px-3 py-2">
          <input value={draft.valas} onChange={(e) => setDraft((d) => ({ ...d, valas: e.target.value }))} type="number" step="any" min="0" onKeyDown={handleKeyDown} disabled={saving || !draftAbroad} className={`${rowInputCls} text-right`} />
        </td>
        <td className="px-3 py-2">
          <input value={draft.gram} onChange={(e) => setDraft((d) => ({ ...d, gram: e.target.value }))} type="number" min="0" onKeyDown={handleKeyDown} disabled={saving} className={`${rowInputCls} text-right`} />
        </td>
        <td className="px-3 py-2 text-right text-xs tabular-nums text-gray-400">
          {draftAbroad ? fmt(draftCountry?.kurs ?? row.kurs) : "—"}
        </td>
        <td className="px-3 py-2 text-right text-xs tabular-nums text-gray-400">
          {draftAbroad ? fmt(draftCountry?.cargoPerKg ?? row.cargoPerKg) : "—"}
        </td>
        <td className="px-3 py-2">
          <input value={draft.profitPct} onChange={(e) => setDraft((d) => ({ ...d, profitPct: e.target.value }))} type="number" min="0" max="99" onKeyDown={handleKeyDown} disabled={saving || !draftAbroad} className={`${rowInputCls} text-right`} />
        </td>
        <td className="px-3 py-2">
          <input value={draft.opFee} onChange={(e) => setDraft((d) => ({ ...d, opFee: e.target.value }))} type="number" min="0" onKeyDown={handleKeyDown} disabled={saving || !draftAbroad} className={`${rowInputCls} text-right`} />
        </td>
        <td className="px-3 py-2">
          <input value={draft.packFee} onChange={(e) => setDraft((d) => ({ ...d, packFee: e.target.value }))} type="number" min="0" onKeyDown={handleKeyDown} disabled={saving || !draftAbroad} className={`${rowInputCls} text-right`} />
        </td>
        <td className="px-3 py-2">
          <input value={draft.cost} onChange={(e) => setDraft((d) => ({ ...d, cost: e.target.value }))} type="number" min="0" onKeyDown={handleKeyDown} disabled={saving || draftAbroad} className={`${rowInputCls} text-right`} />
        </td>
        <td className="px-3 py-2">
          <input value={draft.profitFixed} onChange={(e) => setDraft((d) => ({ ...d, profitFixed: e.target.value }))} type="number" min="0" onKeyDown={handleKeyDown} disabled={saving || draftAbroad} className={`${rowInputCls} text-right`} />
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-col gap-1 items-end">
            <div className="flex gap-1">
              <button type="button" onClick={handleSave} disabled={saving} className="px-2 py-1 rounded-md bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors">
                {saving ? "…" : "Save"}
              </button>
              <button type="button" onClick={() => { setEditing(false); setSaveError(null) }} disabled={saving} className="px-2 py-1 rounded-md border border-cream-border text-gray-500 text-xs hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
                Cancel
              </button>
            </div>
            {saveError && <p className="text-xs text-red-500 text-right">{saveError}</p>}
          </div>
        </td>
      </tr>
    )
  }

  return (
    <tr className="border-b border-cream-border/60 hover:bg-cream/30 transition-colors">
      <td className="px-4 py-3 font-medium whitespace-nowrap">{row.name}</td>
      <td className="px-4 py-3 text-gray-600">{row.store}</td>
      <td className="px-4 py-3 text-right tabular-nums font-medium">{fmt(row.price)}</td>
      <td className="px-4 py-3 text-center">
        <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${abroad ? "bg-blue-50 text-blue-600" : "bg-green-50 text-green-600"}`}>
          {abroad ? "Abroad" : "Domestic"}
        </span>
      </td>
      <td className="px-4 py-3 text-gray-600">{row.countryName || "—"}</td>
      <td className="px-4 py-3 text-right tabular-nums">{abroad ? row.valas : "—"}</td>
      <td className="px-4 py-3 text-right tabular-nums">{row.gram || "—"}</td>
      <td className="px-4 py-3 text-right tabular-nums">{abroad ? fmt(row.kurs) : "—"}</td>
      <td className="px-4 py-3 text-right tabular-nums">{abroad ? fmt(row.cargoPerKg) : "—"}</td>
      <td className="px-4 py-3 text-right tabular-nums">{abroad ? `${row.profitPct}%` : "—"}</td>
      <td className="px-4 py-3 text-right tabular-nums">{abroad ? fmt(row.operationalFee) : "—"}</td>
      <td className="px-4 py-3 text-right tabular-nums">{abroad ? fmt(row.packingFee) : "—"}</td>
      <td className="px-4 py-3 text-right tabular-nums">{!abroad ? fmt(row.cost) : "—"}</td>
      <td className="px-4 py-3 text-right tabular-nums">{!abroad ? fmt(row.profitFixed) : "—"}</td>
      <td className="px-4 py-3">
        <div className="flex gap-2">
          <button type="button" onClick={startEdit} title="Edit" className="text-gray-400 hover:text-brand transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
            </svg>
          </button>
          <button type="button" onClick={handleDelete} disabled={deleting} title="Delete" className="text-gray-400 hover:text-red-500 disabled:opacity-50 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </td>
    </tr>
  )
}
