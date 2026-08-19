"use client"

import { useEffect, useState } from "react"

interface Product { id: number; name: string; store: string; price: number }

export default function ProductSearchPicker({
  alreadyAddedIds,
  onPick,
}: {
  alreadyAddedIds: Set<number>
  onPick: (product: Product) => void
}) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<Product[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([])
      return
    }
    const handle = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/whatsapp/sends/search-products?q=${encodeURIComponent(query)}`)
        const data = await res.json()
        setResults(data.products ?? [])
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => clearTimeout(handle)
  }, [query])

  return (
    <div className="flex flex-col gap-2">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Cari produk (nama atau toko)…"
        className="border border-cream-border rounded-lg px-3 py-2 text-sm"
      />
      {loading && <p className="text-xs text-gray-400">Mencari…</p>}
      <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
        {results.map((p) => {
          const already = alreadyAddedIds.has(p.id)
          return (
            <button
              key={p.id}
              type="button"
              disabled={already}
              onClick={() => onPick(p)}
              className={`flex items-center gap-2 text-left px-2 py-1.5 rounded-lg text-xs border ${
                already ? "border-cream-border bg-cream-border/40 text-gray-400 cursor-not-allowed" : "border-cream-border hover:border-brand"
              }`}
            >
              <span className="flex-1">{p.name}</span>
              <span className="text-gray-500">{p.store}</span>
              <span className="text-gray-500">Rp {p.price.toLocaleString("id-ID")}</span>
              {already && <span className="text-[10px] font-bold uppercase">sudah</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
