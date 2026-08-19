"use client"

import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import type { CataloguePost, CatalogueHighlight } from "@/lib/db"
import EventSelect from "@/components/EventSelect"
import ComposerUploadStep from "./ComposerUploadStep"
import ComposerProductStep from "./ComposerProductStep"

export default function CataloguePostsClient() {
  const options = useSheetOptions()
  const searchParams = useSearchParams()
  const [composerOpen, setComposerOpen] = useState(searchParams.get("compose") === "1")
  const [posts, setPosts] = useState<CataloguePost[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [highlights, setHighlights] = useState<CatalogueHighlight[]>([])
  const [editingHighlight, setEditingHighlight] = useState<CatalogueHighlight | null>(null)

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

  async function reloadHighlights() {
    try {
      const res = await fetch("/api/sheets/catalogue-highlights", { cache: "no-store" })
      const data = await res.json()
      setHighlights(data.highlights ?? [])
    } catch {
      // Highlights are a management convenience — a failed load shouldn't
      // block the rest of the page (posts still load/render normally).
    }
  }

  useEffect(() => { reload(); reloadHighlights() }, [])

  async function toggleVisible(post: CataloguePost) {
    setPosts((prev) => prev.map((p) => p.id === post.id ? { ...p, visible: !p.visible } : p))
    try {
      const res = await fetch(`/api/sheets/catalogue-posts/${post.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visible: !post.visible }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? "Failed to update visibility")
      }
    } catch (err) {
      setPosts((prev) => prev.map((p) => p.id === post.id ? { ...p, visible: post.visible } : p))
      setError(err instanceof Error ? err.message : "Failed to update visibility")
    }
  }

  async function assignHighlight(post: CataloguePost, highlightId: number | null) {
    setPosts((prev) => prev.map((p) => p.id === post.id ? { ...p, highlightId } : p))
    try {
      const res = await fetch(`/api/sheets/catalogue-posts/${post.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ highlightId }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? "Failed to update highlight")
      }
    } catch (err) {
      // Re-read server truth instead of guessing at a rollback value —
      // avoids the same-row race where a slow failed request's rollback
      // could clobber a faster, later successful change.
      reload()
      setError(err instanceof Error ? err.message : "Failed to update highlight")
    }
  }

  if (composerOpen) {
    return (
      <ComposerFlow
        activeEvents={options?.activeEvents ?? []}
        onClose={() => { setComposerOpen(false); reload() }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <UploadForm options={options} highlights={highlights} onCreated={reload} />
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-medium text-gray-500">Highlights</span>
        {highlights.map((h) => (
          <button
            key={h.id}
            onClick={() => setEditingHighlight(h)}
            className={`px-2.5 py-1 rounded-full text-xs border ${h.visible ? "border-cream-border" : "border-gray-200 text-gray-400"}`}
          >
            {h.name} ✎
          </button>
        ))}
        <button
          onClick={() => setEditingHighlight({ id: 0, name: "", defaultEvent: null, sortOrder: 0, visible: true, createdAt: "", updatedAt: "" })}
          className="px-2.5 py-1 rounded-full text-xs border border-dashed border-cream-border text-gray-500"
        >
          + New
        </button>
      </div>
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
              <div className="flex items-center gap-2">
                <select
                  value={post.highlightId ?? ""}
                  onChange={(e) => assignHighlight(post, e.target.value ? Number(e.target.value) : null)}
                  className="text-xs border border-cream-border rounded-lg px-1.5 py-1"
                >
                  <option value="">No highlight</option>
                  {highlights.map((h) => (
                    <option key={h.id} value={h.id}>{h.name}{h.visible ? "" : " (hidden)"}</option>
                  ))}
                </select>
                <button
                  onClick={() => toggleVisible(post)}
                  className={`px-3 py-1.5 rounded-lg text-xs border ${post.visible ? "bg-brand text-white border-brand" : "border-cream-border text-gray-500"}`}
                >
                  {post.visible ? "Visible" : "Hidden"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {editingHighlight && (
        <HighlightModal
          highlight={editingHighlight}
          activeEvents={options?.activeEvents ?? []}
          onClose={() => setEditingHighlight(null)}
          onSaved={() => { setEditingHighlight(null); reloadHighlights() }}
        />
      )}
    </div>
  )
}

/**
 * The composer's two-step flow: `ComposerUploadStep` (Task 8) creates a
 * fresh `wa_sends` row and hands off `sendId`/`mediaUrl`/`prefillFromPostId`;
 * `ComposerProductStep` (Task 9) continues from there. `onClose` doubles as
 * both steps' exit path (the header's "Back to posts" and the product
 * step's "Simpan draf"/post-send `onDone`), and always reloads the plain
 * post list — the composer can create a real `catalogue_posts` row and tag
 * products on it, so the list is stale otherwise until a manual refresh.
 */
function ComposerFlow({ activeEvents, onClose }: { activeEvents: string[]; onClose: () => void }) {
  const [state, setState] = useState<
    | { step: "upload" }
    | { step: "product"; sendId: number; mediaUrl: string; prefillFromPostId?: number }
  >({ step: "upload" })

  // The "Foto baru" path hands off a client-side blob: URL (no stored
  // media_url to read yet) — revoke it once the product step moves past it
  // or the composer closes. A no-op for "Pakai post lama"'s real https URL:
  // revokeObjectURL on a URL it didn't create simply does nothing.
  useEffect(() => {
    if (state.step !== "product") return
    const url = state.mediaUrl
    return () => URL.revokeObjectURL(url)
  }, [state])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">New product post</h2>
        <button onClick={onClose} className="text-xs text-gray-500 underline">Back to posts</button>
      </div>
      {state.step === "upload" ? (
        <ComposerUploadStep
          activeEvents={activeEvents}
          onCreated={(sendId, mediaUrl, prefillFromPostId) =>
            setState({ step: "product", sendId, mediaUrl, prefillFromPostId })
          }
        />
      ) : (
        <ComposerProductStep
          sendId={state.sendId}
          mediaUrl={state.mediaUrl}
          prefillFromPostId={state.prefillFromPostId}
          onDone={onClose}
        />
      )}
    </div>
  )
}

function UploadForm({ options, highlights, onCreated }: { options: ReturnType<typeof useSheetOptions>; highlights: CatalogueHighlight[]; onCreated: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [caption, setCaption] = useState("")
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [highlightId, setHighlightId] = useState<string>("")
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
      if (highlightId) form.set("highlightId", highlightId)
      const res = await fetch("/api/sheets/catalogue-posts", { method: "POST", body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      setFile(null); setCaption(""); setSelectedIds(new Set()); setHighlightId("")
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
      <select
        value={highlightId}
        onChange={(e) => setHighlightId(e.target.value)}
        className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
      >
        <option value="">No highlight</option>
        {highlights.map((h) => (
          <option key={h.id} value={h.id}>{h.name}{h.visible ? "" : " (hidden)"}</option>
        ))}
      </select>
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

function HighlightModal({ highlight, activeEvents, onClose, onSaved }: {
  highlight: CatalogueHighlight
  activeEvents: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const isNew = highlight.id === 0
  const [name, setName] = useState(highlight.name)
  const [defaultEvent, setDefaultEvent] = useState(highlight.defaultEvent ?? "")
  const [sortOrder, setSortOrder] = useState(String(highlight.sortOrder))
  const [visible, setVisible] = useState(highlight.visible)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  async function submit() {
    if (!name.trim()) { setError("Name is required"); return }
    setSubmitting(true); setError("")
    try {
      const body = {
        name: name.trim(),
        defaultEvent: defaultEvent || null,
        sortOrder: Number(sortOrder) || 0,
        visible,
      }
      const res = isNew
        ? await fetch("/api/sheets/catalogue-highlights", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await fetch(`/api/sheets/catalogue-highlights/${highlight.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl p-5 w-full max-w-sm flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-foreground">{isNew ? "New highlight" : "Edit highlight"}</h3>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Highlight name"
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
        />
        <EventSelect value={defaultEvent} onChange={setDefaultEvent} events={activeEvents} placeholder="Default event (optional)…" clearable />
        <input
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
          placeholder="Sort order"
          type="number"
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
        />
        {!isNew && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
            Visible to customers
          </label>
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}
