"use client"

import { useEffect, useState } from "react"
import Link from "next/link"

interface ShopPost {
  id: number
  event: string
  store: string
  sku: number
  claimed: number
  bought: number
}

export default function ShopClient() {
  const [posts, setPosts] = useState<ShopPost[] | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/whatsapp/shop", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { posts?: ShopPost[]; error?: string }) => {
        if (data.error) setError(data.error)
        else setPosts(data.posts ?? [])
      })
      .catch(() => setError("Failed to load"))
  }, [])

  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (!posts) return <p className="text-sm text-gray-500">Loading…</p>
  if (posts.length === 0) {
    return <p className="text-sm text-gray-500">No shelves posted for an active event yet.</p>
  }

  return (
    <div className="flex flex-col gap-2">
      {posts.map((post) => {
        const left = post.claimed - post.bought
        return (
          <Link
            key={post.id}
            href={`/dashboard/shop/${post.id}`}
            className="flex items-center gap-3 rounded-xl border border-cream-border bg-white px-4 py-3 hover:border-brand transition-colors"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground truncate">
                {post.store || "Untitled shelf"}
              </div>
              <div className="text-xs text-gray-500 tabular-nums">
                {post.event} · {post.sku} SKU
              </div>
            </div>
            <div className="text-right shrink-0">
              <div
                className={`text-sm font-bold tabular-nums ${left === 0 ? "text-green-700" : "text-red-700"}`}
              >
                {left === 0 ? "Done" : `Buy ${left}`}
              </div>
              <div className="text-xs text-gray-500 tabular-nums">
                {post.bought} of {post.claimed}
              </div>
            </div>
          </Link>
        )
      })}
    </div>
  )
}
