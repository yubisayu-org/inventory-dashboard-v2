"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import SearchInput from "@/components/SearchInput"
import { PaginationButton } from "@/components/Pagination"
import { storeKey } from "../shop/stores"

interface Post {
  id: number
  event: string
  store: string
  note: string
  sku: number
  claimed: number
  bought: number
  createdAt: string
}

const PAGE_SIZE = 25

/**
 * The page's shelves under the store they were photographed in.
 *
 * Grouped in the order the rows arrive rather than re-sorted: this is the
 * archive, so newest-first is what it is for, and a store heading appears each
 * time that store's shelves come round again. Group Order sorts by what is left
 * to buy instead, because it is walked rather than read.
 */
function groupPage(rows: Post[]): { key: string; name: string; posts: Post[] }[] {
  const out: { key: string; name: string; posts: Post[] }[] = []

  for (const post of rows) {
    const key = storeKey(post.store)
    const last = out[out.length - 1]
    if (last && last.key === key) last.posts.push(post)
    else out.push({ key, name: post.store.trim() || "Untitled shelf", posts: [post] })
  }
  return out
}

export default function PostsClient() {
  const [rows, setRows] = useState<Post[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [closed, setClosed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
    if (search) params.set("search", search)

    fetch(`/api/whatsapp/posts?${params}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { rows?: Post[]; totalCount?: number; error?: string }) => {
        if (data.error) setError(data.error)
        else {
          setRows(data.rows ?? [])
          setTotalCount(data.totalCount ?? 0)
        }
      })
      .catch(() => setError("Failed to load"))
      .finally(() => setLoading(false))
  }, [page, search])

  const groups = useMemo(() => groupPage(rows), [rows])
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <SearchInput
          value={search}
          onChange={(v) => {
            setPage(1)
            setSearch(v)
          }}
          placeholder="Search store or note…"
          className="max-w-sm flex-1"
        />
        {/* The other door in. A shelf uploaded here keeps the camera's own
            resolution, where one sent through WhatsApp comes back at about
            1280 across. */}
        <Link
          href="/dashboard/wa-posts/upload"
          className="shrink-0 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white"
        >
          Upload
        </Link>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {loading ? <p className="text-sm text-gray-500">Loading…</p> : null}

      {!loading && rows.length === 0 ? (
        <p className="text-sm text-gray-500">No posts yet.</p>
      ) : null}

      {groups.map((group, index) => {
        // Keyed by position as well as name: one store can appear twice on a
        // page, and folding the morning's shelves must not fold the evening's.
        const id = `${group.key}#${index}`
        const open = closed[id] !== true

        return (
          <div key={id} className="rounded-xl border border-cream-border bg-white overflow-hidden">
            <button
              type="button"
              onClick={() => setClosed((c) => ({ ...c, [id]: open }))}
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
            </button>

            {open
              ? group.posts.map((post) => (
                  <Link
                    key={post.id}
                    href={`/dashboard/wa-posts/${post.id}`}
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
                        {post.note ? (
                          <span className="text-gray-400"> · {post.note}</span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-[11px] text-gray-400 tabular-nums">
                        {post.event} · {post.bought} of {post.claimed} units
                      </div>
                    </div>
                    <div className="text-[11px] text-gray-400 tabular-nums shrink-0">
                      {post.createdAt}
                    </div>
                  </Link>
                ))
              : null}
          </div>
        )
      })}

      {totalPages > 1 ? (
        <div className="flex items-center gap-2">
          <PaginationButton onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
            Prev
          </PaginationButton>
          <span className="text-xs text-gray-500 tabular-nums">
            {page} / {totalPages}
          </span>
          <PaginationButton onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages}>
            Next
          </PaginationButton>
        </div>
      ) : null}
    </div>
  )
}
