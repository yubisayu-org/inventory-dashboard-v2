"use client"

import { useEffect, useState } from "react"

interface Product { id: number; name: string; store: string; price: number }

export default function ProductSearchPicker({
  alreadyAddedIds,
  onPick,
}: {
  alreadyAddedIds: Set<number>
  onPick: (product: Product) => Promise<void> | void
}) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<Product[]>([])
  const [loading, setLoading] = useState(false)
  // A double-click (or a slow round trip + a second, impatient click) must
  // not fire two attach requests for the same product before the first one
  // lands: alreadyAddedIds only greys a product out AFTER the attach
  // round-trip AND a follow-up list refresh both complete, which is exactly
  // the window a double-click falls inside. Blocking ALL picks while any
  // one is in flight (not just the same product) is deliberate — the
  // composer already processes attaches one at a time (see
  // ComposerProductStep's prefill loop), and two concurrent picks of
  // DIFFERENT products can still race the same shared per-event code
  // sequence. See the final whole-branch review's finding 6.
  const [pickingId, setPickingId] = useState<number | null>(null)

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

  async function handlePick(p: Product) {
    if (pickingId !== null) return // a pick is already in flight — ignore re-entrant clicks
    setPickingId(p.id)
    try {
      await onPick(p)
    } finally {
      setPickingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search products (name or store)…"
        className="border border-cream-border rounded-lg px-3 py-2 text-sm"
      />
      {loading && <p className="text-xs text-gray-400">Searching…</p>}
      <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
        {results.map((p) => {
          const already = alreadyAddedIds.has(p.id)
          const picking = pickingId === p.id
          return (
            <button
              key={p.id}
              type="button"
              disabled={already || pickingId !== null}
              onClick={() => handlePick(p)}
              className={`flex items-center gap-2 text-left px-2 py-1.5 rounded-lg text-xs border ${
                already || pickingId !== null ? "border-cream-border bg-cream-border/40 text-gray-400 cursor-not-allowed" : "border-cream-border hover:border-brand"
              }`}
            >
              <span className="flex-1">{p.name}</span>
              <span className="text-gray-500">{p.store}</span>
              <span className="text-gray-500">Rp {p.price.toLocaleString("id-ID")}</span>
              {already && <span className="text-[10px] font-bold uppercase">added</span>}
              {picking && <span className="text-[10px] font-bold uppercase">…</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
