"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"

interface ShopPost {
  id: number
  event: string
  store: string
  sku: number
  claimed: number
  bought: number
}

interface StoreGroup {
  key: string
  name: string
  posts: ShopPost[]
  left: number
}

/**
 * Shelves from one store, together.
 *
 * Store is typed by whoever opened the capture window, so "Nishimatsuya" and
 * "NISHIMATSUYA" are the same shop and must not become two sections. The name
 * shown is the first spelling seen rather than an upper-cased one, because the
 * heading is read by a person, not matched by a machine.
 */
function groupByStore(posts: ShopPost[]): StoreGroup[] {
  const groups = new Map<string, StoreGroup>()

  for (const post of posts) {
    const name = post.store.trim() || "Untitled shelf"
    const key = name.toLowerCase()
    const group = groups.get(key) ?? { key, name, posts: [], left: 0 }
    group.posts.push(post)
    group.left += Math.max(0, post.claimed - post.bought)
    groups.set(key, group)
  }

  // Oldest shelf first inside a shop, which is the order they were photographed
  // in — and the order the racks stand in, because the photographs were taken
  // walking the aisle. Shopping the list top to bottom is then one walk rather
  // than a lap per shelf. Newest-first is right for an archive and wrong here.
  for (const group of groups.values()) group.posts.sort((a, b) => a.id - b.id)

  // Shops with something left first: you are standing in one of them.
  return [...groups.values()].sort((a, b) => {
    if ((a.left === 0) !== (b.left === 0)) return a.left === 0 ? 1 : -1
    return b.left - a.left
  })
}

export default function ShopClient() {
  const [posts, setPosts] = useState<ShopPost[] | null>(null)
  const [error, setError] = useState("")
  // Which stores are folded away. Finished ones start folded, and this holds
  // every deliberate change to that.
  const [closed, setClosed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    fetch("/api/whatsapp/shop", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { posts?: ShopPost[]; error?: string }) => {
        if (data.error) setError(data.error)
        else setPosts(data.posts ?? [])
      })
      .catch(() => setError("Failed to load"))
  }, [])

  const groups = useMemo(() => groupByStore(posts ?? []), [posts])

  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (!posts) return <p className="text-sm text-gray-500">Loading…</p>
  if (posts.length === 0) {
    return <p className="text-sm text-gray-500">No shelves posted for an active event yet.</p>
  }

  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        // A finished store folds itself: it is one green line saying so until
        // somebody asks to see it again.
        const open = closed[group.key] === undefined ? group.left > 0 : !closed[group.key]

        return (
          <div
            key={group.key}
            className="rounded-xl border border-cream-border bg-white overflow-hidden"
          >
            {/* The shopping list's header, to the pixel: brand rule down the
                left, a chevron that turns rather than swapping glyph, count on
                the right. Two screens used in the same shop minutes apart should
                not look like two different products. */}
            <button
              type="button"
              onClick={() => setClosed((c) => ({ ...c, [group.key]: open }))}
              className="w-full flex items-center gap-2.5 px-4 py-3 border-l-[3px] border-brand text-left"
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
                          {post.event} · {post.bought} of {post.claimed} units
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
