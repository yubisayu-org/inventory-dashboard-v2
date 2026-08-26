"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import type { CataloguePost, CatalogueHighlight } from "@/lib/db"
import EventSelect from "@/components/EventSelect"
import SearchInput from "@/components/SearchInput"
import ComposerProductStep from "./ComposerProductStep"

export default function CataloguePostsClient() {
  const options = useSheetOptions()
  const [posts, setPosts] = useState<CataloguePost[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [highlights, setHighlights] = useState<CatalogueHighlight[]>([])
  const [editingHighlight, setEditingHighlight] = useState<CatalogueHighlight | null>(null)
  const [editingProductsPost, setEditingProductsPost] = useState<CataloguePost | null>(null)
  const [selectedPostIds, setSelectedPostIds] = useState<Set<number>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [highlightsOpen, setHighlightsOpen] = useState(false)
  const [viewMode, setViewMode] = useState<"list" | "gallery">("list")
  const [listQuery, setListQuery] = useState("")
  // Sticky across "Kirim ulang" clicks and page reloads — several sends in a
  // row are almost always for the same trip, and there's no single "the
  // active event" to skip the picker for entirely (10 can be active at
  // once). Always starts at "" (matching the server, which has no
  // localStorage) and loads the stored value in an effect after mount —
  // reading it synchronously in the initializer caused a hydration mismatch,
  // since the client's first render would differ from the server's HTML
  // whenever a value was already stored.
  const [defaultEvent, setDefaultEvent] = useState("")
  useEffect(() => {
    const stored = localStorage.getItem("catalogue-posts-default-event")
    if (stored) setDefaultEvent(stored)
  }, [])
  useEffect(() => {
    if (defaultEvent) localStorage.setItem("catalogue-posts-default-event", defaultEvent)
  }, [defaultEvent])

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

  async function bulkSetVisible(ids: number[], visible: boolean) {
    setPosts((prev) => prev.map((p) => ids.includes(p.id) ? { ...p, visible } : p))
    const results = await Promise.all(
      ids.map((id) =>
        fetch(`/api/sheets/catalogue-posts/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visible }),
        }),
      ),
    )
    if (results.some((r) => !r.ok)) {
      reload()
      setError("Failed to update visibility on some posts")
    }
  }

  async function bulkSetHighlight(ids: number[], highlightId: number | null) {
    setPosts((prev) => prev.map((p) => ids.includes(p.id) ? { ...p, highlightId } : p))
    const results = await Promise.all(
      ids.map((id) =>
        fetch(`/api/sheets/catalogue-posts/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ highlightId }),
        }),
      ),
    )
    if (results.some((r) => !r.ok)) {
      reload()
      setError("Failed to update highlight on some posts")
    }
  }

  // Searches title AND tagged product names — a name-only match ("cari
  // Boston Bag") wouldn't hit anything if only the title were checked, and
  // the post's own title is often unrelated to what's actually tagged on it.
  const productNameById = useMemo(() => new Map((options?.items ?? []).map((it) => [it.id, it.name])), [options])
  const productStoreById = useMemo(() => new Map((options?.items ?? []).map((it) => [it.id, it.store])), [options])
  const filteredPosts = useMemo(() => {
    const q = listQuery.trim().toLowerCase()
    if (!q) return posts
    return posts.filter((p) =>
      p.title.toLowerCase().includes(q) ||
      p.productIds.some((id) => (productNameById.get(id) ?? "").toLowerCase().includes(q)),
    )
  }, [posts, listQuery, productNameById])

  // What a row actually shows: the store(s) its tagged products come from
  // when there are any (a title is often blank or a leftover test string —
  // "which store" is the thing that's actually useful at a glance), falling
  // back to the title only when nothing is tagged yet to derive a store
  // from. Product names list alongside the tagged-count for the same
  // reason — the count alone doesn't say what's actually on the post.
  function postSummary(post: CataloguePost) {
    const names = post.productIds
      .map((id) => productNameById.get(id))
      .filter((n): n is string => Boolean(n))
    const stores = [...new Set(
      post.productIds.map((id) => productStoreById.get(id)).filter((s): s is string => Boolean(s)),
    )]
    return { names, stores }
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {/* One row on a desktop, two on a phone. The fixed widths here come to
          about 550px before the search field is given anything, so on a phone
          the row used to run off the side and Highlights and Add Post sat past
          the edge.
      
          The two rows are columns as well: search over the trip filter, the
          bulk tick over Highlights, the view toggle over Add Post. That is why
          the toggle and Add Post are both w-24 below sm — the toggle is two
          48px halves, and matching it is what makes the grid read as one.
      
          sm:order-* restores the original left-to-right sequence above sm, so
          the desktop toolbar is exactly as it was. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* Row one: search and the controls that act on the list it shows.
            sm:contents dissolves each group on a desktop so every child rejoins
            one row — one layout that bends, not a phone copy kept in step. */}
        <div className="flex items-center gap-2 w-full sm:contents">
          {/* The shared search box, as on every other list screen: magnifier on
              the left, a clear button once there is something to clear. This was
              the one page still using a bare input. */}
          <SearchInput
            value={listQuery}
            onChange={setListQuery}
            placeholder="Cari judul atau nama produk…"
            className="flex-1 min-w-0 sm:order-1"
          />
          <button
            onClick={() => setBulkOpen(true)}
            disabled={selectedPostIds.size === 0}
            aria-label="Bulk actions"
            title="Bulk actions"
            className={`relative h-10 w-10 sm:order-3 flex items-center justify-center rounded-lg border border-cream-border shrink-0 ${
              selectedPostIds.size > 0 ? "bg-brand text-white" : "bg-white text-faint"
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" /><path d="M13 6h8" /><path d="M13 12h8" /><path d="M13 18h8" />
            </svg>
            {selectedPostIds.size > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-white text-brand text-[10px] font-bold flex items-center justify-center border border-brand">
                {selectedPostIds.size}
              </span>
            )}
          </button>
          <div className="flex items-center h-10 w-24 sm:w-auto sm:order-5 rounded-lg border border-cream-border overflow-hidden shrink-0">
            <button
              onClick={() => setViewMode("list")}
              aria-label="Tampilan list"
              title="List"
              className={`h-full px-4 flex items-center ${viewMode === "list" ? "bg-brand text-white" : "bg-white text-faint"}`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </button>
            <button
              onClick={() => setViewMode("gallery")}
              aria-label="Tampilan gallery"
              title="Gallery"
              className={`h-full px-4 flex items-center border-l border-cream-border ${viewMode === "gallery" ? "bg-brand text-white" : "bg-white text-faint"}`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </button>
          </div>
        </div>
        {/* Row two: the trip filter and the things that act on a trip. */}
        <div className="flex items-center gap-2 w-full sm:contents">
          <div className="flex-1 min-w-0 sm:flex-none sm:w-56 sm:shrink-0 sm:order-2">
            <EventSelect value={defaultEvent} onChange={setDefaultEvent} events={options?.activeEvents ?? []} placeholder="Default trip…" clearable />
          </div>
          <button
            onClick={() => setHighlightsOpen(true)}
            aria-label="Highlights"
            title="Highlights"
            className="h-10 w-10 sm:order-4 flex items-center justify-center rounded-lg border border-cream-border bg-white text-faint shrink-0"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setAddOpen((o) => !o)}
            className={`inline-flex items-center justify-center gap-1.5 h-10 px-4 text-sm rounded-lg border w-24 sm:w-auto shrink-0 sm:order-6 transition-colors ${
              addOpen ? "bg-brand-light text-brand border-brand/30" : "bg-brand text-white border-transparent hover:bg-brand-dark"
            }`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span className="sm:hidden">Add</span>
            <span className="hidden sm:inline">Add Post</span>
          </button>
        </div>
      </div>
      {addOpen && (
        <UploadForm options={options} onCreated={reload} onCancel={() => setAddOpen(false)} />
      )}
      {highlightsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setHighlightsOpen(false)}>
          <div className="bg-white rounded-xl p-5 w-full max-w-sm flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">Highlights</span>
              <button onClick={() => setHighlightsOpen(false)} aria-label="Close" className="text-faint hover:text-foreground">
                &times;
              </button>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {highlights.map((h) => (
                <button
                  key={h.id}
                  onClick={() => { setHighlightsOpen(false); setEditingHighlight(h) }}
                  className={`px-2.5 py-1 rounded-full text-xs border ${h.visible ? "border-cream-border" : "border-cream-border text-faint"}`}
                >
                  {h.name} ✎
                </button>
              ))}
              <button
                onClick={() => {
                  setHighlightsOpen(false)
                  setEditingHighlight({ id: 0, name: "", defaultEvent: null, sortOrder: 0, visible: true, createdAt: "", updatedAt: "" })
                }}
                className="px-2.5 py-1 rounded-full text-xs border border-dashed border-cream-border text-muted"
              >
                + New
              </button>
            </div>
          </div>
        </div>
      )}
      {bulkOpen && selectedPostIds.size > 0 && (
        <BulkActionsModal
          posts={posts.filter((p) => selectedPostIds.has(p.id))}
          highlights={highlights}
          activeEvents={options?.activeEvents ?? []}
          defaultEvent={defaultEvent}
          onSetVisible={(visible) => bulkSetVisible([...selectedPostIds], visible)}
          onSetHighlight={(highlightId) => bulkSetHighlight([...selectedPostIds], highlightId)}
          onSent={(event) => { setDefaultEvent(event); setSelectedPostIds(new Set()); setBulkOpen(false); reload() }}
          onClose={() => setBulkOpen(false)}
        />
      )}
      {loading ? (
        <p className="text-sm text-faint">Loading…</p>
      ) : filteredPosts.length === 0 ? (
        <p className="text-sm text-faint">
          {listQuery.trim() ? `Tidak ada yang cocok dengan "${listQuery}".` : "Belum ada post."}
        </p>
      ) : viewMode === "list" ? (
        <div className="flex flex-col gap-2">
          {filteredPosts.map((post) => {
            const { names, stores } = postSummary(post)
            const label = post.productIds.length > 0 ? (stores.map((s) => s.toUpperCase()).join(", ") || "N/A") : "N/A"
            const muted = post.productIds.length === 0
            const complete = Boolean(post.title) && post.productIds.length > 0 && post.pinnedCount >= post.productIds.length
            return (
            <div key={post.id} className="flex items-center justify-between rounded-xl border border-cream-border bg-white p-3">
              <div className="flex items-center gap-3 min-w-0">
                <input
                  type="checkbox"
                  checked={selectedPostIds.has(post.id)}
                  onChange={() => setSelectedPostIds((prev) => {
                    const next = new Set(prev)
                    if (next.has(post.id)) next.delete(post.id); else next.add(post.id)
                    return next
                  })}
                  className="accent-brand shrink-0"
                  aria-label="Pilih post"
                />
                {post.mediaType === "video" ? (
                  <video src={post.mediaUrl} controls muted playsInline className="w-9 h-9 object-cover rounded-lg bg-black" />
                ) : (
                  <img src={post.mediaUrl} alt="" className="w-9 h-9 object-cover rounded-lg" />
                )}
                <div className="min-w-0 flex-1">
                  <PostTitleLabel label={label} muted={muted} />
                  <p className="flex items-center gap-1 text-xs text-faint truncate">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
                      <circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" />
                    </svg>
                    <span className="truncate">
                      {post.productIds.length}
                      {names.length > 0 ? ` · ${names.join(", ")}` : ""}
                    </span>
                  </p>
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
                  onClick={() => setEditingProductsPost(post)}
                  aria-label="Edit title & products"
                  title="Edit title & products"
                  className={`p-1.5 rounded-lg border border-cream-border ${complete ? "text-brand" : "text-muted"}`}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                  </svg>
                </button>
                <button
                  onClick={() => toggleVisible(post)}
                  aria-label={post.visible ? "Visible — klik untuk sembunyikan" : "Hidden — klik untuk tampilkan"}
                  title={post.visible ? "Visible" : "Hidden"}
                  className={`p-1.5 rounded-lg border border-cream-border ${post.visible ? "text-brand" : "text-muted"}`}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
                    <circle cx="12" cy="12" r="3" />
                    {!post.visible && <line x1="3" y1="21" x2="21" y2="3" />}
                  </svg>
                </button>
                <ResendButton
                  post={post}
                  activeEvents={options?.activeEvents ?? []}
                  defaultEvent={defaultEvent}
                  onSent={(event) => { setDefaultEvent(event); reload() }}
                />
              </div>
            </div>
            )
          })}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {filteredPosts.map((post) => {
            const { names, stores } = postSummary(post)
            const label = post.productIds.length > 0 ? (stores.map((s) => s.toUpperCase()).join(", ") || "N/A") : "N/A"
            const muted = post.productIds.length === 0
            const complete = Boolean(post.title) && post.productIds.length > 0 && post.pinnedCount >= post.productIds.length
            return (
            <div key={post.id} className="relative flex flex-col gap-1.5 rounded-xl border border-cream-border bg-white p-2">
              <input
                type="checkbox"
                checked={selectedPostIds.has(post.id)}
                onChange={() => setSelectedPostIds((prev) => {
                  const next = new Set(prev)
                  if (next.has(post.id)) next.delete(post.id); else next.add(post.id)
                  return next
                })}
                className="absolute top-3 left-3 z-10 accent-brand"
                aria-label="Pilih post"
              />
              <div className="relative">
                {post.mediaType === "video" ? (
                  <video src={post.mediaUrl} muted className="w-full aspect-square object-cover rounded-lg bg-black" />
                ) : (
                  <img src={post.mediaUrl} alt="" className="w-full aspect-square object-cover rounded-lg" />
                )}
                <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
                  <button
                    onClick={() => setEditingProductsPost(post)}
                    aria-label="Edit title & products"
                    title="Edit title & products"
                    className={`p-1.5 rounded-lg border border-cream-border bg-white/90 backdrop-blur-sm shadow-sm ${complete ? "text-brand" : "text-muted"}`}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => toggleVisible(post)}
                    aria-label={post.visible ? "Visible — klik untuk sembunyikan" : "Hidden — klik untuk tampilkan"}
                    title={post.visible ? "Visible" : "Hidden"}
                    className={`p-1.5 rounded-lg border border-cream-border bg-white/90 backdrop-blur-sm shadow-sm ${post.visible ? "text-brand" : "text-muted"}`}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
                      <circle cx="12" cy="12" r="3" />
                      {!post.visible && <line x1="3" y1="21" x2="21" y2="3" />}
                    </svg>
                  </button>
                  <ResendButton
                    post={post}
                    activeEvents={options?.activeEvents ?? []}
                    defaultEvent={defaultEvent}
                    onSent={(event) => { setDefaultEvent(event); reload() }}
                  />
                </div>
              </div>
              <PostTitleLabel label={label} muted={muted} />
              <p className="flex items-center gap-1 text-xs text-faint truncate">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                  <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
                  <circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" />
                </svg>
                <span className="truncate">
                  {post.productIds.length}
                  {names.length > 0 ? ` · ${names.join(", ")}` : ""}
                </span>
              </p>
            </div>
            )
          })}
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
      {editingProductsPost && (
        <EditProductsModal
          post={editingProductsPost}
          defaultEvent={defaultEvent}
          activeEvents={options?.activeEvents ?? []}
          onClose={() => { setEditingProductsPost(null); reload() }}
        />
      )}
    </div>
  )
}

/** Inline-editable title on a post row — the only place to change it once
 *  set, since the composer no longer asks for one at send time (migration
 *  086: title lives on the post, not the send). Local state so typing
 *  doesn't round-trip on every keystroke; saves on blur, only if changed. */
// Just a display now — title and product tags are one screen
// (EditProductsModal), reached only through the pencil link below. Two
// separate clickable things opening the same modal was redundant.
function PostTitleLabel({ label, muted }: { label: string; muted: boolean }) {
  return (
    <p className={`text-sm truncate ${muted ? "text-amber-600" : "text-foreground"}`}>
      {label}
    </p>
  )
}

/**
 * All bulk actions for the current selection in one place — visibility,
 * highlight, and send — instead of two bars that used to sit permanently
 * under the toolbar whenever anything was selected. Opened from the bulk
 * icon button next to the list/gallery toggle.
 */
function BulkActionsModal({ posts, highlights, activeEvents, defaultEvent, onSetVisible, onSetHighlight, onSent, onClose }: {
  posts: CataloguePost[]
  highlights: CatalogueHighlight[]
  activeEvents: string[]
  defaultEvent: string
  onSetVisible: (visible: boolean) => void
  onSetHighlight: (highlightId: number | null) => void
  onSent: (event: string) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl p-5 w-full max-w-md flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">{posts.length} dipilih</h3>
          <button onClick={onClose} className="text-faint hover:text-foreground text-lg leading-none">&times;</button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => onSetVisible(true)}
            className="px-2.5 py-1 rounded-lg text-xs border border-cream-border text-muted"
          >
            Set Visible
          </button>
          <button
            onClick={() => onSetVisible(false)}
            className="px-2.5 py-1 rounded-lg text-xs border border-cream-border text-muted"
          >
            Set Hidden
          </button>
          <select
            value=""
            onChange={(e) => {
              const v = e.target.value
              onSetHighlight(v === "__none__" ? null : Number(v))
            }}
            className="text-xs border border-cream-border rounded-lg px-1.5 py-1"
          >
            <option value="" disabled>Set highlight…</option>
            <option value="__none__">No highlight</option>
            {highlights.map((h) => (
              <option key={h.id} value={h.id}>{h.name}{h.visible ? "" : " (hidden)"}</option>
            ))}
          </select>
        </div>

        <BulkSendBar
          posts={posts}
          activeEvents={activeEvents}
          defaultEvent={defaultEvent}
          onDone={onSent}
          onCancel={onClose}
        />
      </div>
    </div>
  )
}

/**
 * Bulk "Kirim"/"Kirim ulang" — one trip, every selected post, sent
 * sequentially through the same POST /api/whatsapp/sends/quick-resend each
 * individual button already uses. A post with no title can't be sent
 * (quick-resend's own check) — surfaced per-row here rather than silently
 * skipped, since a bulk pick is exactly where that's easy to not notice.
 */
function BulkSendBar({ posts, activeEvents, defaultEvent, onDone, onCancel }: {
  posts: CataloguePost[]
  activeEvents: string[]
  defaultEvent: string
  onDone: (event: string) => void
  onCancel: () => void
}) {
  const [event, setEvent] = useState(defaultEvent)
  const [jobs, setJobs] = useState<
    { postId: number; title: string; status: "queued" | "sending" | "done" | "failed"; error?: string }[] | null
  >(null)
  const sending = jobs !== null && jobs.some((j) => j.status === "queued" || j.status === "sending")

  async function send() {
    if (!event) return
    const initial = posts.map((p) => ({
      postId: p.id,
      title: p.title || "(untitled)",
      status: p.title.trim() ? ("queued" as const) : ("failed" as const),
      error: p.title.trim() ? undefined : "Belum ada judul",
    }))
    setJobs(initial)

    for (const job of initial) {
      if (job.status === "failed") continue
      setJobs((prev) => prev!.map((j) => j.postId === job.postId ? { ...j, status: "sending" } : j))
      try {
        const res = await fetch("/api/whatsapp/sends/quick-resend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ postId: job.postId, event }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Gagal mengirim")
        setJobs((prev) => prev!.map((j) => j.postId === job.postId ? { ...j, status: "done" } : j))
      } catch (err) {
        setJobs((prev) => prev!.map((j) =>
          j.postId === job.postId ? { ...j, status: "failed", error: err instanceof Error ? err.message : "Gagal" } : j,
        ))
      }
    }
  }

  const allDone = jobs !== null && jobs.every((j) => j.status === "done" || j.status === "failed")

  return (
    <div className="rounded-xl border border-green-200 bg-green-50 p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-foreground">{posts.length} post dipilih</span>
        {jobs === null && (
          <>
            <div className="w-48">
              <EventSelect value={event} onChange={setEvent} events={activeEvents} placeholder="Pilih trip…" />
            </div>
            <button
              onClick={send}
              disabled={!event}
              className="px-3 py-1.5 rounded-lg text-xs bg-brand text-white disabled:opacity-50"
            >
              📤 Kirim ke {event || "…"}
            </button>
            <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-xs text-muted">
              Batal
            </button>
          </>
        )}
        {allDone && (
          <button onClick={() => onDone(event)} className="px-3 py-1.5 rounded-lg text-xs bg-brand text-white">
            Selesai
          </button>
        )}
      </div>
      {jobs && (
        <div className="rounded-lg border border-cream-border bg-white overflow-hidden">
          {jobs.map((job) => (
            <div key={job.postId} className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-cream-border last:border-b-0">
              <span className="flex-1 min-w-0 truncate">{job.title}</span>
              {job.status === "queued" && <span className="text-faint">Menunggu…</span>}
              {job.status === "sending" && <span className="text-faint">Mengirim…</span>}
              {job.status === "done" && <span className="text-green-600">✓ Terkirim</span>}
              {job.status === "failed" && <span className="text-red-500" title={job.error}>Gagal — {job.error}</span>}
            </div>
          ))}
        </div>
      )}
      {sending && <p className="text-[11px] text-muted">Mengirim satu per satu — jangan tutup halaman ini.</p>}
    </div>
  )
}

/**
 * Retag an existing post — the fix for "No active products to send"
 * (quick-resend's activeIds check has no other way to resolve): drop a
 * discontinued product, add its replacement. Same search-when-typing /
 * show-selected-when-empty pattern as UploadForm's checklist, except the
 * empty-query view is sourced from EVERY product, not just active ones —
 * an already-tagged discontinued product has to stay visible here so it can
 * be unticked, even though searching for a NEW one only turns up active
 * stock (re-adding something discontinued isn't the point of this screen).
 */
/**
 * Editing a post's tags is really the composer's product step, just entered
 * from the plain list instead of a fresh upload — same search/tag/pin/send
 * UI, reused as-is rather than rebuilt. It needs a real `wa_sends` row to
 * attach codes and pins to (they don't exist at the post level), so this
 * first finds-or-creates a draft send for the chosen trip via
 * POST /api/whatsapp/sends/draft-for-post, then hands off to
 * ComposerProductStep exactly like "New product post" does.
 */
function EditProductsModal({ post, defaultEvent, activeEvents, onClose }: {
  post: CataloguePost
  defaultEvent: string
  activeEvents: string[]
  onClose: () => void
}) {
  const [event, setEvent] = useState(defaultEvent)
  const [draft, setDraft] = useState<{ sendId: number; isNew: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  async function start() {
    if (!event) return
    setLoading(true)
    setError("")
    try {
      const res = await fetch("/api/whatsapp/sends/draft-for-post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId: post.id, event }),
      })
      // A body is not guaranteed: a route that throws answers 500 with nothing
      // in it, and parsing that reports a JSON error instead of the failure.
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `Failed to start (${res.status})`)
      setDraft({ sendId: data.sendId, isNew: data.isNew })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start")
    } finally {
      setLoading(false)
    }
  }

  // A default trip is already picked in the common case — start straight
  // into the editor instead of making that one more click.
  useEffect(() => {
    if (defaultEvent) start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl p-5 w-full max-w-4xl max-h-[90vh] overflow-y-auto flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Edit post</h3>
          <button onClick={onClose} className="text-faint hover:text-foreground text-lg leading-none">&times;</button>
        </div>

        {draft ? (
          <ComposerProductStep
            sendId={draft.sendId}
            postId={post.id}
            mediaUrl={post.mediaUrl}
            mediaType={post.mediaType}
            prefillFromPostId={draft.isNew ? post.id : undefined}
            onDone={onClose}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted">Choose a trip to start tagging products.</p>
            <div className="w-56">
              <EventSelect value={event} onChange={setEvent} events={activeEvents} placeholder="Choose a trip…" />
            </div>
            {error && <p className="text-xs text-red-500">{error}</p>}
            <button
              onClick={start}
              disabled={!event || loading}
              className="self-start px-4 py-2 rounded-lg bg-brand text-white text-sm disabled:opacity-50"
            >
              {loading ? "Loading…" : "Continue"}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * One click, no review: pick a trip, and this post's tagged products go out
 * to it under the post's own title — via POST /api/whatsapp/sends/quick-resend,
 * which runs the composer's own attach/pin/send steps back-to-back
 * server-side. A post that's gone out before also carries forward its last
 * pin positions; a never-sent post goes out with no pins, since none exist
 * yet. No title field here anymore (migration 086) — it's set once, on the
 * post itself, and every send just uses that.
 */
function ResendButton({ post, activeEvents, defaultEvent, onSent }: {
  post: CataloguePost
  activeEvents: string[]
  defaultEvent: string
  onSent: (event: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [event, setEvent] = useState(defaultEvent)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onOutsideClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onOutsideClick)
    return () => document.removeEventListener("mousedown", onOutsideClick)
  }, [open])

  if (!post.title.trim() || post.productIds.length === 0) {
    const reason = !post.title.trim() ? "belum ada judul" : "belum ada produk ditandai"
    return (
      <span
        aria-label={`Tidak bisa kirim — ${reason}`}
        title={`Tidak bisa kirim — ${reason}`}
        className="p-1.5 rounded-lg border border-cream-border bg-white/90 backdrop-blur-sm shadow-sm text-muted"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 2 11 13" />
          <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
          <line x1="3" y1="21" x2="21" y2="3" />
        </svg>
      </span>
    )
  }

  async function send() {
    if (!event) return
    setSending(true)
    setError("")
    try {
      const res = await fetch("/api/whatsapp/sends/quick-resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId: post.id, event }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Gagal mengirim")
      setOpen(false)
      onSent(event)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal mengirim")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={post.everSent ? "Kirim ulang" : "Kirim"}
        title={post.everSent ? "Kirim ulang" : "Kirim"}
        className={`p-1.5 rounded-lg border border-cream-border bg-white/90 backdrop-blur-sm shadow-sm ${post.everSent ? "text-brand" : "text-muted"}`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 2 11 13" />
          <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-10 w-56 rounded-xl border border-cream-border bg-white p-3 shadow-lg flex flex-col gap-2">
          <p className="text-[11px] text-muted">
            {post.everSent
              ? "Kirim produk & pin terakhir ke trip lain, langsung terkirim."
              : "Kirim ke grup untuk pertama kali, langsung terkirim."}
          </p>
          <EventSelect value={event} onChange={setEvent} events={activeEvents} placeholder="Pilih trip…" />
          {error && <p className="text-[11px] text-red-500">{error}</p>}
          <div className="flex justify-end gap-1.5">
            <button onClick={() => setOpen(false)} className="px-2.5 py-1 rounded-lg text-xs text-muted">
              Batal
            </button>
            <button
              onClick={send}
              disabled={!event || sending}
              className="px-3 py-1.5 rounded-lg text-xs bg-brand text-white disabled:opacity-50"
            >
              {sending ? "Mengirim…" : "Kirim"}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function UploadForm({ options, onCreated, onCancel }: {
  options: ReturnType<typeof useSheetOptions>
  onCreated: () => void
  onCancel: () => void
}) {
  // Several photos, one post per file — unlike the composer, this form has
  // no per-photo interactive step (no pin placement), so there's nothing
  // that forces one at a time. Each becomes its own post, uploaded
  // sequentially like the shelf upload's job queue — a failed one shouldn't
  // cost the rest.
  //
  // Products, title and highlight are deliberately NOT set here: with
  // several photos going out together, applying one shared value to all of
  // them was wrong more often than not. Set each one afterward,
  // individually — title/products via the pencil icon, highlight via the
  // row's own select.
  const [files, setFiles] = useState<{ id: string; file: File; status: "queued" | "uploading" | "done" | "failed"; error?: string }[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [dragging, setDragging] = useState(false)

  // Copied out of the FileList before the state update, not inside it —
  // same reordering the shelf upload's own comment explains: the list
  // belongs to the input/drop event, and React runs the updater later.
  function addFiles(list: FileList | null) {
    if (!list) return
    const chosen = [...list].map((file, i) => ({
      id: `${Date.now()}-${i}-${file.name}`,
      file,
      status: "queued" as const,
    }))
    setFiles((prev) => [...prev, ...chosen])
  }

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id))
  }

  async function submit() {
    if (files.length === 0) { setError("Pick a photo or video"); return }
    setSubmitting(true); setError("")

    for (const job of files) {
      if (job.status === "done") continue
      setFiles((prev) => prev.map((f) => f.id === job.id ? { ...f, status: "uploading", error: undefined } : f))
      try {
        // Cap a photo to the same 3000px/quality-70 size a shelf photo gets
        // before it reaches storage — the composer route used to be the only
        // upload path that did this; now that it's retired, this is the only
        // one left, so a full-res phone photo doesn't go straight to
        // Storage uncapped. Video skips it (sharp can't touch it) and
        // uploads exactly as picked, same as before.
        let uploadFile = job.file
        if (job.file.type.startsWith("image/")) {
          const resizeForm = new FormData()
          resizeForm.set("file", job.file)
          const resizeRes = await fetch("/api/whatsapp/composer/resize-photo", { method: "POST", body: resizeForm })
          if (!resizeRes.ok) {
            const data = await resizeRes.json().catch(() => ({}))
            throw new Error(data.error ?? "Failed to process photo")
          }
          const resizedBlob = await resizeRes.blob()
          uploadFile = new File([resizedBlob], job.file.name, { type: resizedBlob.type })
        }

        const form = new FormData()
        form.set("file", uploadFile)
        form.set("title", "")
        form.set("productIds", "[]")
        const res = await fetch("/api/sheets/catalogue-posts", { method: "POST", body: form })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed")
        setFiles((prev) => prev.map((f) => f.id === job.id ? { ...f, status: "done" } : f))
      } catch (err) {
        setFiles((prev) => prev.map((f) =>
          f.id === job.id ? { ...f, status: "failed", error: err instanceof Error ? err.message : "Failed" } : f,
        ))
      }
    }

    setSubmitting(false)
    onCreated()
  }

  // Cleared only once every job succeeded — a failed one stays queued (with
  // its error shown) so retrying "submit" only re-attempts what didn't land,
  // same as the shelf upload's own job list.
  useEffect(() => {
    if (files.length > 0 && files.every((f) => f.status === "done")) {
      setFiles([])
    }
  }, [files])

  return (
    <div className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          addFiles(e.dataTransfer.files)
        }}
        className={`relative rounded-lg border border-dashed py-2 text-center text-sm text-muted transition-colors ${
          dragging ? "border-brand bg-brand/5" : "border-cream-border bg-cream"
        }`}
      >
        <span className="block text-base mb-1">{files.length > 0 ? "✓" : "📷"}</span>
        {files.length > 0
          ? `${files.length} file dipilih — same title/tags applied to each`
          : "Drag photos or videos here (one post per file), or click to choose"}
        <input
          type="file"
          accept="image/*,video/*"
          multiple
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ""
          }}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          aria-label="Choose photos or videos"
        />
      </div>
      {files.length > 0 && (
        <div className="rounded-lg border border-cream-border overflow-hidden">
          {files.map((job) => (
            <div key={job.id} className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-cream-border last:border-b-0">
              <span className="flex-1 min-w-0 truncate">{job.file.name}</span>
              {job.status === "done" && <span className="text-green-600">✓</span>}
              {job.status === "uploading" && <span className="text-faint">Mengirim…</span>}
              {/* The reason inline, not in a tooltip: an upload that failed is
                  read once, often on a phone, where there is nothing to hover.
                  Matches the send list above, which already said it out loud. */}
              {job.status === "failed" && (
                <span className="text-red-500 min-w-0 truncate" title={job.error}>
                  Gagal{job.error ? ` — ${job.error}` : ""}
                </span>
              )}
              {job.status === "queued" && (
                <button type="button" onClick={() => removeFile(job.id)} className="text-faint hover:text-foreground">
                  &times;
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        {error && <p className="text-xs text-red-500">{error}</p>}
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-4 py-2 rounded-lg border border-cream-border text-muted-strong text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={submitting || files.length === 0}
          className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
        >
          {submitting ? "Uploading…" : files.length > 1 ? `Upload ${files.length} posts` : "Upload post"}
        </button>
      </div>
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
          <button onClick={submit} disabled={submitting} className="px-4 py-2 rounded-lg bg-brand text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}
