"use client"

import { useEffect, useState } from "react"
import type { CataloguePost, CatalogueRequest } from "@/lib/db"

type PostWithProducts = CataloguePost & {
  products: { id: number; name: string; store: string; price: number }[]
}

export default function CatalogueClient() {
  const [posts, setPosts] = useState<PostWithProducts[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/public/catalogue", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setError(data.error); return }
        setPosts(data.posts)
      })
      .catch(() => setError("Failed to load catalogue"))
  }, [])

  if (error) return <p className="text-sm text-red-500">{error}</p>
  if (!posts) return <p className="text-sm text-gray-400">Loading…</p>
  if (posts.length === 0) return <p className="text-sm text-gray-400">Nothing here yet.</p>

  return (
    <div className="flex flex-col gap-8">
      {posts.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}
      <StatusLookup />
    </div>
  )
}

function PostCard({ post }: { post: PostWithProducts }) {
  return (
    <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
      {post.mediaType === "video" ? (
        <video src={post.mediaUrl} controls className="w-full max-h-[420px] object-cover bg-black" />
      ) : (
        <img src={post.mediaUrl} alt={post.caption} className="w-full max-h-[420px] object-cover" />
      )}
      {post.caption && <p className="px-4 pt-3 text-sm text-gray-600">{post.caption}</p>}
      <div className="p-4 flex flex-col gap-3">
        {post.products.map((product) => (
          <ProductRequestRow key={product.id} product={product} />
        ))}
      </div>
    </div>
  )
}

function ProductRequestRow({ product }: { product: { id: number; name: string; store: string; price: number } }) {
  const [qty, setQty] = useState("1")
  const [note, setNote] = useState("")
  const [handle, setHandle] = useState(() => (typeof window !== "undefined" ? localStorage.getItem("catalogueHandle") ?? "" : ""))
  const [state, setState] = useState<"idle" | "submitting" | "done" | "error">("idle")
  const [errorMsg, setErrorMsg] = useState("")

  async function submit() {
    if (!handle.trim()) { setErrorMsg("Enter your Instagram handle"); setState("error"); return }
    setState("submitting")
    try {
      const res = await fetch("/api/public/catalogue/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerHandle: handle, productId: product.id, qty: Number(qty), note }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      localStorage.setItem("catalogueHandle", handle)
      setState("done")
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed")
      setState("error")
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-cream-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{product.name}</span>
        <span className="text-xs text-gray-400">Rp {product.price.toLocaleString("id-ID")}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="Your IG handle"
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm w-32"
        />
        <input
          type="number"
          min="1"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm w-16"
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm flex-1 min-w-[8rem]"
        />
        <button
          onClick={submit}
          disabled={state === "submitting" || state === "done"}
          className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50"
        >
          {state === "done" ? "Requested ✓" : state === "submitting" ? "…" : "Fix"}
        </button>
      </div>
      {state === "error" && <p className="text-xs text-red-500">{errorMsg}</p>}
    </div>
  )
}

function StatusLookup() {
  const [handle, setHandle] = useState("")
  const [requests, setRequests] = useState<CatalogueRequest[] | null>(null)

  async function check() {
    const res = await fetch(`/api/public/catalogue/requests?handle=${encodeURIComponent(handle)}`, { cache: "no-store" })
    const data = await res.json()
    setRequests(data.requests ?? [])
  }

  return (
    <div className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">Check my requests</h2>
      <div className="flex gap-2">
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="Your IG handle"
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm flex-1"
        />
        <button onClick={check} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Check</button>
      </div>
      {requests && (
        <div className="flex flex-col gap-2">
          {requests.length === 0 && <p className="text-xs text-gray-400">No requests found.</p>}
          {requests.map((r) => (
            <div key={r.id} className="flex items-center justify-between text-xs">
              <span>{r.productName} × {r.qty}</span>
              <span className={r.status === "converted" ? "text-green-600" : r.status === "rejected" ? "text-red-500" : "text-gray-400"}>
                {r.status}{r.status === "rejected" && r.staffNote ? ` — ${r.staffNote}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
