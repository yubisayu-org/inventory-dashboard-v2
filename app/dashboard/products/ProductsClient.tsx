"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { ProductIndoRow } from "@/lib/db"
import { useResizableColumns } from "@/hooks/useResizableColumns"

const EMPTY_FORM = { product: "", store: "", price: "" }

const formInputCls = "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const rowInputCls = "w-full border border-cream-border rounded-md px-2 py-1 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-50"

export default function ProductsClient() {
  const [data, setData] = useState<ProductIndoRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState(EMPTY_FORM)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/products-indo")
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to load")
      setData(json as ProductIndoRow[])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const stores = useMemo(() => {
    if (!data) return []
    return [...new Set(data.map((r) => r.store).filter(Boolean))].sort()
  }, [data])

  const { widths, startResize } = useResizableColumns({ product: 200, store: 160, price: 120, action: 60 })

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setAdding(true)
    setAddError(null)
    try {
      const res = await fetch("/api/sheets/products-indo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product: form.product,
          store: form.store,
          price: Number(form.price) || 0,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to add")
      setForm(EMPTY_FORM)
      setData((prev) => [...(prev ?? []), json as ProductIndoRow])
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
        <div className="text-sm font-semibold text-foreground">Tambah Produk</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <input
            {...field("product")}
            placeholder="Product"
            required
            disabled={adding}
            className={formInputCls}
          />
          <input
            {...field("store")}
            list="stores-list"
            placeholder="Store"
            required
            disabled={adding}
            className={formInputCls}
          />
          <input
            {...field("price")}
            type="number"
            min="0"
            placeholder="Price"
            required
            disabled={adding}
            className={formInputCls}
          />
        </div>

        <datalist id="stores-list">
          {stores.map((s) => <option key={s} value={s} />)}
        </datalist>

        <div className="flex items-center justify-end gap-3">
          {addError && <p className="text-xs text-red-500">{addError}</p>}
          <button
            type="submit"
            disabled={adding}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {adding ? "Menyimpan…" : "Tambah"}
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
          Belum ada produk.
        </div>
      )}
      {!loading && !error && data && data.length > 0 && (
        <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-cream-border bg-cream">
                  <th className="px-4 py-3 font-medium relative select-none" style={{ width: widths.product }}>
                    Product
                    <div onMouseDown={(e) => startResize("product", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                  <th className="px-4 py-3 font-medium relative select-none" style={{ width: widths.store }}>
                    Store
                    <div onMouseDown={(e) => startResize("store", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                  <th className="px-4 py-3 font-medium text-right relative select-none" style={{ width: widths.price }}>
                    Price
                    <div onMouseDown={(e) => startResize("price", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                  <th className="px-4 py-3 font-medium relative select-none" style={{ width: widths.action }}>
                    <div onMouseDown={(e) => startResize("action", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <ProductRow
                    key={row.rowNumber}
                    row={row}
                    onUpdated={(updated) =>
                      setData((prev) =>
                        prev?.map((r) => r.rowNumber === row.rowNumber ? { ...r, ...updated } : r) ?? null
                      )
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

function ProductRow({
  row,
  onUpdated,
}: {
  row: ProductIndoRow
  onUpdated: (data: Partial<ProductIndoRow>) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({
    product: row.product,
    store: row.store,
    price: String(row.price),
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) firstInputRef.current?.focus()
  }, [editing])

  function startEdit() {
    setDraft({
      product: row.product,
      store: row.store,
      price: String(row.price),
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
    const price = Number(draft.price) || 0
    try {
      const res = await fetch("/api/sheets/products-indo", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rowNumber: row.rowNumber,
          product: draft.product.trim(),
          store: draft.store.trim(),
          price,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onUpdated({ product: draft.product.trim(), store: draft.store.trim(), price })
      setEditing(false)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
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

  const fmt = (n: number) => n.toLocaleString("id-ID")

  return (
    <tr className="border-b border-cream-border/60 hover:bg-cream/30 transition-colors">
      {editing ? (
        <>
          <td className="px-3 py-2">
            <input ref={firstInputRef} {...draftField("product")} className={rowInputCls} placeholder="Product" />
          </td>
          <td className="px-3 py-2">
            <input {...draftField("store")} list="stores-list" className={rowInputCls} placeholder="Store" />
          </td>
          <td className="px-3 py-2">
            <input {...draftField("price")} type="number" min="0" className={`${rowInputCls} text-right`} placeholder="Price" />
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
                  {saving ? "…" : "Simpan"}
                </button>
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={saving}
                  className="px-2 py-1 rounded-md border border-cream-border text-gray-500 text-xs hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
                >
                  Batal
                </button>
              </div>
              {saveError && <p className="text-xs text-red-500 text-right">{saveError}</p>}
            </div>
          </td>
        </>
      ) : (
        <>
          <td className="px-4 py-3 font-medium">{row.product}</td>
          <td className="px-4 py-3 text-gray-600">{row.store}</td>
          <td className="px-4 py-3 text-right tabular-nums font-medium">{fmt(row.price)}</td>
          <td className="px-4 py-3">
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
          </td>
        </>
      )}
    </tr>
  )
}
