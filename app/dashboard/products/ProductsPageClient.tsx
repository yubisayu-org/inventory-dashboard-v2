"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ProductRow, CountryRow } from "@/lib/db"
import DataGrid, { numericFilter, textContainsFilter, type ColumnDef } from "@/components/DataGrid"
import SearchableSelect from "@/components/SearchableSelect"

type PricingType = "overseas" | "domestic"

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

  const columns = useMemo<ColumnDef<ProductRow, unknown>[]>(() => [
    {
      accessorKey: "id",
      header: "ID",
      enableColumnFilter: false,
      size: 60,
    },
    {
      accessorKey: "name",
      header: "Name",
      filterFn: "textContains" as unknown as undefined,
      cell: ({ row }) => <span className="font-medium whitespace-nowrap">{row.original.name}</span>,
    },
    {
      accessorKey: "store",
      header: "Store",
      filterFn: "textContains" as unknown as undefined,
    },
    {
      accessorKey: "price",
      header: "Price",
      filterFn: "numeric" as unknown as undefined,
      cell: ({ row }) => <span className="tabular-nums font-medium">{fmt(row.original.price)}</span>,
      meta: { align: "right" },
    },
    {
      id: "type",
      header: "Type",
      accessorFn: (row) => isAbroad(row) ? "Overseas" : "Domestic",
      filterFn: "textContains" as unknown as undefined,
      cell: ({ row }) => {
        const abroad = isAbroad(row.original)
        return (
          <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${abroad ? "bg-blue-50 text-blue-600" : "bg-green-50 text-green-600"}`}>
            {abroad ? "Overseas" : "Domestic"}
          </span>
        )
      },
    },
    {
      accessorKey: "countryName",
      header: "Country",
      filterFn: "textContains" as unknown as undefined,
      cell: ({ row }) => <span className="text-gray-600">{row.original.countryName || "—"}</span>,
    },
    {
      accessorKey: "valas",
      header: "Valas",
      filterFn: "numeric" as unknown as undefined,
      cell: ({ row }) => <span className="tabular-nums">{isAbroad(row.original) ? row.original.valas : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "gram",
      header: "Gram",
      filterFn: "numeric" as unknown as undefined,
      cell: ({ row }) => <span className="tabular-nums">{row.original.gram || "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "kurs",
      header: "Kurs",
      filterFn: "numeric" as unknown as undefined,
      cell: ({ row }) => <span className="tabular-nums">{isAbroad(row.original) ? fmt(row.original.kurs) : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "cargoPerKg",
      header: "Cargo/kg",
      filterFn: "numeric" as unknown as undefined,
      cell: ({ row }) => <span className="tabular-nums">{isAbroad(row.original) ? fmt(row.original.cargoPerKg) : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "profitPct",
      header: "%",
      filterFn: "numeric" as unknown as undefined,
      cell: ({ row }) => <span className="tabular-nums">{isAbroad(row.original) ? `${row.original.profitPct}%` : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "operationalFee",
      header: "Op Fee",
      filterFn: "numeric" as unknown as undefined,
      cell: ({ row }) => <span className="tabular-nums">{isAbroad(row.original) ? fmt(row.original.operationalFee) : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "packingFee",
      header: "Pack Fee",
      filterFn: "numeric" as unknown as undefined,
      cell: ({ row }) => <span className="tabular-nums">{isAbroad(row.original) ? fmt(row.original.packingFee) : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "cost",
      header: "Base Cost",
      filterFn: "numeric" as unknown as undefined,
      cell: ({ row }) => <span className="tabular-nums">{!isAbroad(row.original) ? fmt(row.original.cost) : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "profitFixed",
      header: "Fixed Profit",
      filterFn: "numeric" as unknown as undefined,
      cell: ({ row }) => <span className="tabular-nums">{!isAbroad(row.original) ? fmt(row.original.profitFixed) : "—"}</span>,
      meta: { align: "right" },
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      filterFn: "textContains" as unknown as undefined,
    },
    {
      accessorKey: "updatedAt",
      header: "Updated",
      filterFn: "textContains" as unknown as undefined,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      enableColumnFilter: false,
      enableHiding: false,
      cell: ({ row }) => (
        <ProductActions
          row={row.original}
          countries={countries}
          stores={stores}
          onUpdated={(updated) =>
            setData((prev) =>
              prev?.map((r) => (r.id === row.original.id ? { ...r, ...updated } : r)) ?? null,
            )
          }
          onDeleted={() => setData((prev) => prev?.filter((r) => r.id !== row.original.id) ?? null)}
        />
      ),
    },
  ], [countries, stores])

  const refreshButton = (
    <button
      type="button"
      onClick={load}
      disabled={loading}
      className="text-xs text-gray-500 hover:text-brand disabled:opacity-50 transition-colors px-3 py-1.5 rounded-lg border border-cream-border hover:border-brand"
    >
      {loading ? "…" : "Refresh"}
    </button>
  )

  return (
    <div className="flex flex-col gap-6">
      {/* Add form */}
      <AddProductForm countries={countries} stores={stores} onAdded={() => load()} />

      {loading && <div className="text-sm text-gray-400 py-12 text-center">Loading…</div>}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {!loading && !error && data && (
        <DataGrid
          data={data}
          columns={columns}
          getRowId={(row) => String(row.id)}
          searchPlaceholder="Search name, store…"
          toolbarExtra={refreshButton}
          initialSorting={[{ id: "id", desc: true }]}
          initialVisibility={{
            id: false,
            kurs: false,
            cargoPerKg: false,
            operationalFee: false,
            packingFee: false,
            createdAt: false,
            updatedAt: false,
          }}
        />
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
  const [type, setType] = useState<PricingType>("overseas")
  const [name, setName] = useState("")
  const [store, setStore] = useState("")
  const [countryId, setCountryId] = useState<number | null>(countries[0]?.id ?? null)
  const [valas, setValas] = useState("")
  const [gram, setGram] = useState("")
  const [profitPct, setProfitPct] = useState("30")
  const [opFee, setOpFee] = useState("5000")
  const [packFee, setPackFee] = useState("5000")
  const [cost, setCost] = useState("")
  const [profitFixed, setProfitFixed] = useState("")
  const [profitManual, setProfitManual] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const selectedCountry = countries.find((c) => c.id === countryId)

  const pricePreview = useMemo(() => {
    if (type === "overseas") {
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

      if (type === "overseas") {
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

      setName("")
      setStore("")
      setValas("")
      setGram("")
      setProfitPct("30")
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
            onClick={() => setType("overseas")}
            className={`px-3 py-1 transition-colors ${type === "overseas" ? "bg-brand text-white font-medium" : "bg-white text-gray-600 hover:bg-cream"}`}
          >
            Overseas
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

      {type === "overseas" && (
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
            <input value={profitPct} onChange={(e) => setProfitPct(e.target.value)} type="number" min="0" max="99" placeholder="30" disabled={adding} className={formInputCls} />
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
              <span>Profit: {fmt(Math.round(pricePreview.price - pricePreview.cogs - (Number(opFee) || 0) - (Number(packFee) || 0)))}</span>
            </div>
          )}
        </div>
      )}

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

// ─── Product actions (edit/delete) ─────────────────────────────────────────

function ProductActions({
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
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

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

  if (editing) {
    return (
      <EditProductModal
        row={row}
        countries={countries}
        stores={stores}
        onSave={(updated) => { onUpdated(updated); setEditing(false) }}
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

// ─── Edit modal ────────────────────────────────────────────────────────────

function EditProductModal({
  row,
  countries,
  stores,
  onSave,
  onCancel,
}: {
  row: ProductRow
  countries: CountryRow[]
  stores: string[]
  onSave: (updated: Partial<ProductRow>) => void
  onCancel: () => void
}) {
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

      onSave({
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
          <span className="text-sm font-semibold text-foreground">Edit Product</span>
          <span className="text-xs text-gray-400">ID: {row.id}</span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} disabled={saving} className={formInputCls} />
          </Field>
          <Field label="Store">
            <SearchableSelect
              value={draft.store}
              onChange={(v) => setDraft((d) => ({ ...d, store: v }))}
              options={stores.map((s) => ({ value: s, label: s }))}
              placeholder="Store…"
              allowNewValue
              disabled={saving}
            />
          </Field>
        </div>

        <Field label="Type">
          <select
            value={draft.countryId ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, countryId: e.target.value ? Number(e.target.value) : null }))}
            disabled={saving}
            className={formInputCls}
          >
            <option value="">Domestic</option>
            {countries.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>)}
          </select>
        </Field>

        {draftAbroad ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Valas">
              <input value={draft.valas} onChange={(e) => setDraft((d) => ({ ...d, valas: e.target.value }))} type="number" step="any" min="0" disabled={saving} className={formInputCls} />
            </Field>
            <Field label="Gram">
              <input value={draft.gram} onChange={(e) => setDraft((d) => ({ ...d, gram: e.target.value }))} type="number" min="0" disabled={saving} className={formInputCls} />
            </Field>
            <Field label="Profit %">
              <input value={draft.profitPct} onChange={(e) => setDraft((d) => ({ ...d, profitPct: e.target.value }))} type="number" min="0" max="99" disabled={saving} className={formInputCls} />
            </Field>
            <Field label="Op Fee">
              <input value={draft.opFee} onChange={(e) => setDraft((d) => ({ ...d, opFee: e.target.value }))} type="number" min="0" disabled={saving} className={formInputCls} />
            </Field>
            <Field label="Pack Fee">
              <input value={draft.packFee} onChange={(e) => setDraft((d) => ({ ...d, packFee: e.target.value }))} type="number" min="0" disabled={saving} className={formInputCls} />
            </Field>
            {draftCountry && (
              <div className="col-span-2 flex gap-4 text-xs text-gray-500 items-center">
                <span>Kurs: {fmt(draftCountry.kurs)}</span>
                <span>Cargo/kg: {fmt(draftCountry.cargoPerKg)}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Base Cost">
              <input value={draft.cost} onChange={(e) => setDraft((d) => ({ ...d, cost: e.target.value }))} type="number" min="0" disabled={saving} className={formInputCls} />
            </Field>
            <Field label="Fixed Profit">
              <input value={draft.profitFixed} onChange={(e) => setDraft((d) => ({ ...d, profitFixed: e.target.value }))} type="number" min="0" disabled={saving} className={formInputCls} />
            </Field>
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-cream-border">
          <div className="text-sm">
            <span className="text-gray-500">Price: </span>
            <span className="font-semibold text-foreground">Rp {fmt(editPrice)}</span>
          </div>
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
