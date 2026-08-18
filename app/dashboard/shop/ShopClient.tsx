"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import SearchInput from "@/components/SearchInput"
import { groupByStore, type ShopPost } from "./stores"

export default function ShopClient() {
  const [posts, setPosts] = useState<ShopPost[] | null>(null)
  const [error, setError] = useState("")
  // Which stores are folded away. Finished ones start folded, and this holds
  // every deliberate change to that.
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const [search, setSearch] = useState("")
  // Whether racks nobody claimed on are listed. Off by default: they are the
  // majority, and none of them is anything to buy.
  const [showEmpty, setShowEmpty] = useState(false)
  // Shops closed for orders, keyed "event|store". Per trip, because the same
  // shop can be open on one trip and finished on another.
  const [shut, setShut] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetch(`/api/whatsapp/shop${showEmpty ? "?all=true" : ""}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { posts?: ShopPost[]; error?: string }) => {
        if (data.error) setError(data.error)
        else setPosts(data.posts ?? [])
      })
      .catch(() => setError("Failed to load"))
  }, [showEmpty])

  const events = useMemo(() => [...new Set((posts ?? []).map((p) => p.event))], [posts])

  useEffect(() => {
    if (events.length === 0) return
    Promise.all(
      events.map((event) =>
        fetch(`/api/whatsapp/store-closures?event=${encodeURIComponent(event)}`, {
          cache: "no-store",
        })
          .then((r) => (r.ok ? r.json() : { closed: [] }))
          .then((data: { closed: string[] }) => data.closed.map((store) => `${event}|${store}`)),
      ),
    ).then((all) => setShut(new Set(all.flat())))
  }, [events])

  /**
   * Close a shop for orders, or reopen it.
   *
   * Here rather than on the archive page because this is the screen open while
   * walking a trip — the moment a shop is finished is the moment you leave it.
   * Hiding is all it does: the shelves, their claims and this list are
   * untouched, and only the customer catalogue stops showing them.
   */
  async function setStoreClosed(event: string, store: string, isClosed: boolean) {
    const key = `${event}|${store.trim().toLowerCase()}`
    setShut((all) => {
      const next = new Set(all)
      if (isClosed) next.add(key)
      else next.delete(key)
      return next
    })
    await fetch("/api/whatsapp/store-closures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, store, closed: isClosed }),
    })
  }

  // Filtered here rather than at the API: a trip is a hundred shelves at most,
  // they are already in the browser, and typing should narrow the list on the
  // keystroke rather than after a round trip in a shop's wifi.
  const groups = useMemo(() => {
    const query = search.trim().toLowerCase()
    const matching = query
      ? (posts ?? []).filter(
          (p) =>
            p.store.toLowerCase().includes(query) || p.event.toLowerCase().includes(query),
        )
      : posts ?? []
    return groupByStore(matching)
  }, [posts, search])

  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (!posts) return <p className="text-sm text-gray-500">Loading…</p>
  if (posts.length === 0) {
    return <p className="text-sm text-gray-500">No shelves posted for an active event yet.</p>
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search store or trip…"
          className="max-w-sm flex-1"
        />
        {/* Racks the group ignored. Hidden by default because none of them is
            anything to buy, and shown when the question is whether a rack was
            posted at all. */}
        <button
          type="button"
          onClick={() => setShowEmpty((shown) => !shown)}
          aria-label={showEmpty ? "Hide shelves with no claims" : "Show shelves with no claims"}
          title={showEmpty ? "Hiding nothing" : "Shelves with no claims are hidden"}
          className={`shrink-0 rounded-xl border px-3 py-2 ${
            showEmpty
              ? "border-brand bg-brand/5 text-brand"
              : "border-cream-border bg-white text-gray-400"
          }`}
        >
          {showEmpty ? (
            <svg
              width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          ) : (
            <svg
              width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-6.5 0-10-8-10-8a18.45 18.45 0 0 1 5.06-5.94" />
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19" />
              <path d="m1 1 22 22" />
            </svg>
          )}
        </button>

        {/* The other way a shelf gets in. Here rather than on the archive page:
            uploading happens in the shop, which is where this screen is used. */}
        <Link
          href="/dashboard/wa-posts/upload"
          className="shrink-0 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white"
        >
          Upload
        </Link>
      </div>

      {groups.length === 0 && search ? (
        <p className="text-sm text-gray-500">No shelf matches “{search}”.</p>
      ) : null}

      {groups.map((group) => {
        // A finished store folds itself: it is one green line saying so until
        // somebody asks to see it again.
        const open = closed[group.key] === undefined ? group.left > 0 : !closed[group.key]
        // Every shelf in a store group belongs to one trip, so the first says
        // which one the closure applies to.
        const event = group.posts[0].event
        const shopShut = shut.has(`${event}|${group.key}`)

        return (
          <div
            key={group.key}
            className="rounded-xl border border-cream-border bg-white overflow-hidden"
          >
            {/* The shopping list's header, to the pixel: brand rule down the
                left, a chevron that turns rather than swapping glyph, count on
                the right. Two screens used in the same shop minutes apart should
                not look like two different products. */}
            <div className="flex items-center border-l-[3px] border-brand">
            <button
              type="button"
              onClick={() => setClosed((c) => ({ ...c, [group.key]: open }))}
              className="flex-1 min-w-0 flex items-center gap-2.5 px-4 py-3 text-left"
            >
              <svg
                width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                className={`text-gray-400 transition-transform ${open ? "" : "-rotate-90"}`}
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
              <span className="font-bold text-sm text-foreground truncate">{group.name}</span>
              <span className="ml-auto text-xs text-gray-400 tabular-nums shrink-0">
                {group.posts.length} {group.posts.length === 1 ? "shelf" : "shelves"}
              </span>
              <span
                className={`text-sm font-bold tabular-nums shrink-0 ${
                  group.left === 0 ? "text-green-700" : "text-red-700"
                }`}
              >
                {group.left === 0 ? "Done" : `Buy ${group.left}`}
              </span>
            </button>

            {/* Closed hides the shop from the customer catalogue and nothing
                else: its shelves, their claims and this list are untouched, and
                anyone still holding the photo in WhatsApp can still mark it. */}
            <button
              type="button"
              onClick={() => setStoreClosed(event, group.key, !shopShut)}
              title={
                shopShut
                  ? "Closed for orders — hidden from the catalogue"
                  : "Open for orders — visible in the catalogue"
              }
              className={`shrink-0 mr-3 ml-2 rounded-full border px-2.5 py-1 text-[11px] font-bold ${
                shopShut
                  ? "border-cream-border bg-cream text-gray-500"
                  : "border-green-200 bg-green-50 text-green-700"
              }`}
            >
              {shopShut ? "Closed" : "Open"}
            </button>
            </div>

            {open
              ? group.posts.map((post) => {
                  const left = post.claimed - post.bought
                  return (
                    <Link
                      key={post.id}
                      href={`/dashboard/shop/${post.id}`}
                      className="flex items-center gap-3 px-4 py-2.5 border-t border-cream-border hover:bg-cream transition-colors"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- our own render route. */}
                      <img
                        src={`/api/whatsapp/posts/${post.id}/rekap`}
                        alt=""
                        className="w-10 h-10 rounded object-cover shrink-0 border border-cream-border"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-foreground tabular-nums">
                          {post.sku} SKU
                        </div>
                        <div className="mt-0.5 text-[11px] text-gray-400 tabular-nums">
                          {post.event} · {post.createdAt} · {post.bought} of {post.claimed} units
                        </div>
                      </div>
                      {/* Bold is what is left to buy, exactly as the shopping
                          list reads it — the faded figure is context, never the
                          number acted on. */}
                      <div
                        className={`text-sm font-bold tabular-nums whitespace-nowrap ${
                          left === 0 ? "text-green-700" : "text-foreground"
                        }`}
                      >
                        {left === 0 ? "Done" : left}
                        {left > 0 && left < post.claimed ? (
                          <span className="text-gray-400 font-normal" title="Partially bought">
                            {" "}/ {post.claimed}
                          </span>
                        ) : null}
                      </div>
                    </Link>
                  )
                })
              : null}
          </div>
        )
      })}
    </div>
  )
}
