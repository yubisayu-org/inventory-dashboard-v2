"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import SearchInput from "@/components/SearchInput"
import { PaginationButton } from "@/components/Pagination"

interface Post {
  id: number
  event: string
  store: string
  note: string
  createdAt: string
}

const PAGE_SIZE = 25

export default function PostsClient() {
  const [rows, setRows] = useState<Post[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

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

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  return (
    <div className="flex flex-col gap-3">
      <SearchInput
        value={search}
        onChange={(v) => {
          setPage(1)
          setSearch(v)
        }}
        placeholder="Search store or note…"
        className="max-w-sm"
      />

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {loading ? <p className="text-sm text-gray-500">Loading…</p> : null}

      {!loading && rows.length === 0 ? (
        <p className="text-sm text-gray-500">No posts yet.</p>
      ) : null}

      <div className="flex flex-col gap-2">
        {rows.map((post) => (
          <Link
            key={post.id}
            href={`/dashboard/wa-posts/${post.id}`}
            className="flex items-center gap-3 rounded-xl border border-cream-border bg-white px-4 py-3 hover:border-brand transition-colors"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground truncate">
                {post.store || "Untitled shelf"}
              </div>
              <div className="text-xs text-gray-500">{post.event}</div>
            </div>
            <div className="text-xs text-gray-400 tabular-nums shrink-0">{post.createdAt}</div>
          </Link>
        ))}
      </div>

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
