"use client"

import { useEffect, useMemo, useState } from "react"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import type { CataloguePost } from "@/lib/db"

export default function CataloguePostsClient() {
  const options = useSheetOptions()
  const [posts, setPosts] = useState<CataloguePost[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/catalogue-posts", { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to load")
      setPosts(data.posts ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() }, [])

  async function toggleVisible(post: CataloguePost) {
    setPosts((prev) => prev.map((p) => p.id === post.id ? { ...p, visible: !p.visible } : p))
    await fetch(`/api/sheets/catalogue-posts/${post.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visible: !post.visible }),
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <UploadForm options={options} onCreated={reload} />
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <div className="flex flex-col gap-2">
          {posts.map((post) => (
            <div key={post.id} className="flex items-center justify-between rounded-xl border border-cream-border bg-white p-3">
              <div className="flex items-center gap-3">
                {post.mediaType === "video" ? (
                  <video src={post.mediaUrl} controls muted playsInline className="w-16 h-16 object-cover rounded-lg bg-black" />
                ) : (
                  <img src={post.mediaUrl} alt="" className="w-16 h-16 object-cover rounded-lg" />
                )}
                <div>
                  <div className="text-sm text-foreground">{post.caption || "(no caption)"}</div>
                  <div className="text-xs text-gray-400">{post.productIds.length} product{post.productIds.length === 1 ? "" : "s"} tagged</div>
                </div>
              </div>
              <button
                onClick={() => toggleVisible(post)}
                className={`px-3 py-1.5 rounded-lg text-xs border ${post.visible ? "bg-brand text-white border-brand" : "border-cream-border text-gray-500"}`}
              >
                {post.visible ? "Visible" : "Hidden"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function UploadForm({ options, onCreated }: { options: ReturnType<typeof useSheetOptions>; onCreated: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [caption, setCaption] = useState("")
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  const items = useMemo(() => (options?.items ?? []).filter((it) => it.active), [options])

  function toggleProduct(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function submit() {
    if (!file) { setError("Pick a photo or video"); return }
    setSubmitting(true); setError("")
    try {
      const form = new FormData()
      form.set("file", file)
      form.set("caption", caption)
      form.set("productIds", JSON.stringify([...selectedIds]))
      const res = await fetch("/api/sheets/catalogue-posts", { method: "POST", body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      setFile(null); setCaption(""); setSelectedIds(new Set())
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">New post</h2>
      <input type="file" accept="image/*,video/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
      <input
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        placeholder="Caption (optional)"
        className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
      />
      <div className="flex flex-col gap-1 max-h-48 overflow-y-auto border border-cream-border rounded-lg p-2">
        {items.map((item) => (
          <label key={item.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleProduct(item.id)} className="accent-brand" />
            {item.name}
          </label>
        ))}
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <button
        onClick={submit}
        disabled={submitting}
        className="self-start px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50"
      >
        {submitting ? "Uploading…" : "Create post"}
      </button>
    </div>
  )
}
