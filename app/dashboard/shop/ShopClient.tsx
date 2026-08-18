"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import SearchInput from "@/components/SearchInput"
import { PaginationButton } from "@/components/Pagination"
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
  // Which trips are listed: the ones running, or the ones over. Never both —
  // shelves from a finished trip look exactly like today's.
  const [showArchived, setShowArchived] = useState(false)
  const [page, setPage] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const [pageSize, setPageSize] = useState(100)
  const [dmOpen, setDmOpen] = useState(false)
  // Shops closed for orders, keyed "event|store". Per trip, because the same
  // shop can be open on one trip and finished on another.
  const [shut, setShut] = useState<Set<string>>(new Set())

  useEffect(() => {
    const query = new URLSearchParams({ page: String(page) })
    if (showEmpty) query.set("all", "true")
    if (showArchived) query.set("archived", "true")

    fetch(`/api/whatsapp/shop${query.size ? `?${query}` : ""}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data: {
        posts?: ShopPost[]
        totalCount?: number
        pageSize?: number
        error?: string
      }) => {
        if (data.error) setError(data.error)
        else {
          setPosts(data.posts ?? [])
          setTotalCount(data.totalCount ?? 0)
          setPageSize(data.pageSize ?? 100)
        }
      })
      .catch(() => setError("Failed to load"))
  }, [showEmpty, showArchived, page])

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
          onClick={() => {
            setPage(1)
            setShowEmpty((shown) => !shown)
          }}
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

        {/* Finished trips. Their shelves cannot be shopped and their catalogue
            is dark, but "what did we carry in March" is a question this screen
            can answer as well as the archive can. */}
        <button
          type="button"
          onClick={() => {
            setPage(1)
            setShowArchived((shown) => !shown)
          }}
          aria-label={showArchived ? "Back to the trips running" : "Show finished trips only"}
          title={showArchived ? "Showing finished trips" : "Showing the trips still running"}
          className={`shrink-0 rounded-xl border px-3 py-2 ${
            showArchived
              ? "border-brand bg-brand/5 text-brand"
              : "border-cream-border bg-white text-gray-400"
          }`}
        >
          <svg
            width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <rect x="2" y="3" width="20" height="5" rx="1" />
            <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
            <path d="M10 12h4" />
          </svg>
        </button>

        {/* A photo a customer marked and sent privately. The shelf is worked
            out from the picture, because a screenshot in an inbox rarely says
            which rack it was. */}
        <button
          type="button"
          onClick={() => setDmOpen(true)}
          aria-label="Record a marked photo sent by DM"
          title="Marked photo from a DM"
          className="shrink-0 rounded-xl border border-cream-border bg-white px-3 py-2 text-gray-500"
        >
          <svg
            width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>

        {/* The other way a shelf gets in. Here rather than on the archive page:
            uploading happens in the shop, which is where this screen is used. */}
        <Link
          href="/dashboard/shop/upload"
          className="shrink-0 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white"
        >
          Upload
        </Link>
      </div>

      {dmOpen ? <DmPhotoSheet onClose={() => setDmOpen(false)} /> : null}

      {showArchived ? (
        <p className="text-xs text-gray-500">
          Finished trips. Nothing here can be shopped — the counts are what they
          ended at.
        </p>
      ) : null}

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
              {/* The count belongs to the name, not to the far edge: "9 shelves"
                  says how big this shop is, which is read with the shop rather
                  than with what is left to buy. */}
              {/* Upper-cased on screen rather than in the data: the name is typed
                  by hand when a capture window opens, and half the trip arrives
                  as "Birthday" and half as "BIRTHDAY". */}
              <span className="min-w-0 truncate text-sm font-bold uppercase text-foreground">
                {group.name}
                <span className="font-normal text-gray-400 tabular-nums">
                  {" · "}
                  {group.posts.length} {group.posts.length === 1 ? "SHELF" : "SHELVES"}
                </span>
              </span>
            </button>

            {/* A switch, not a label: closing a shop is something you do, and
                a pill reading "Open" looked like a status somebody else set.
                It hides the shop from the customer catalogue and nothing else —
                its shelves, their claims and this list are untouched, and
                anyone still holding the photo in WhatsApp can still mark it. */}
            <button
              type="button"
              role="switch"
              aria-checked={!shopShut}
              onClick={() => setStoreClosed(event, group.key, !shopShut)}
              title={
                shopShut
                  ? "Closed for orders — hidden from the catalogue"
                  : "Open for orders — visible in the catalogue"
              }
              className="shrink-0 mr-3 ml-2 flex items-center gap-2"
            >
              <span
                className={`relative h-5 w-9 rounded-full transition-colors ${
                  shopShut ? "bg-gray-300" : "bg-green-600"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                    shopShut ? "left-0.5" : "left-[1.125rem]"
                  }`}
                />
              </span>
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
                        // Nothing claimed is grey: a rack the group ignored has
                        // not been bought, and a tick would say it had.
                        className={`flex items-center gap-1 text-sm font-bold tabular-nums whitespace-nowrap ${
                          post.claimed === 0
                            ? "text-gray-300"
                            : left === 0
                              ? "text-green-700"
                              : "text-red-700"
                        }`}
                      >
                        {post.claimed === 0 ? (
                          <svg
                  width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2.4" strokeLinecap="round"
                >
                  <path d="M5 12h14" />
                </svg>
                        ) : left === 0 ? (
                          <svg
                  width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                        ) : (
                          <svg
                            width="15" height="15" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="m5 11 4-7" />
                            <path d="m19 11-4-7" />
                            <path d="M2 11h20l-1.8 8.1a2 2 0 0 1-2 1.9H5.8a2 2 0 0 1-2-1.9z" />
                            <path d="M9 15v3" />
                            <path d="M15 15v3" />
                          </svg>
                        )}
                      </div>
                    </Link>
                  )
                })
              : null}
          </div>
        )
      })}

      {/* Only when a page is not the whole list. A running trip fits in one;
          a season of finished ones does not. */}
      {totalCount > pageSize ? (
        <div className="flex items-center gap-2">
          <PaginationButton onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
            Prev
          </PaginationButton>
          <span className="text-xs text-gray-500 tabular-nums">
            {page} / {Math.ceil(totalCount / pageSize)}
          </span>
          <PaginationButton
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= Math.ceil(totalCount / pageSize)}
          >
            Next
          </PaginationButton>
        </div>
      ) : null}
    </div>
  )
}

/**
 * A marked photo forwarded from a private message.
 *
 * Two steps, deliberately: the photo is matched against the shelves of running
 * trips and the answer is shown before anything is written. A wrong match would
 * otherwise put somebody's order on the wrong rack, and the picture is the only
 * evidence of which rack it was.
 */
function DmPhotoSheet({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [customer, setCustomer] = useState("")
  const [caption, setCaption] = useState("")
  const [match, setMatch] = useState<
    | null
    | { postId: number; store: string; event: string; marks: number }
  >(null)
  const [saved, setSaved] = useState<{ postId: number; claims: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function send(confirm: boolean) {
    if (!file) return
    setBusy(true)
    setError("")

    const body = new FormData()
    body.append("file", file)
    body.append("customer", customer)
    body.append("caption", caption)
    if (confirm) body.append("confirm", "true")

    const res = await fetch("/api/whatsapp/claims/marked", { method: "POST", body })
    const payload = await res.json().catch(() => ({ error: "Failed" }))
    setBusy(false)

    if (!res.ok) {
      setError(payload.error ?? "Failed")
      return
    }
    if (confirm) setSaved({ postId: payload.postId, claims: payload.claims })
    else setMatch(payload.match)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-2xl bg-white p-4 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto h-1 w-9 rounded-full bg-gray-300" />
        <div>
          <h2 className="text-sm font-bold text-foreground">Foto bertanda dari DM</h2>
          <p className="text-[11px] text-gray-500">
            Raknya dicari otomatis dari fotonya, sama seperti pelanggan yang lupa reply.
          </p>
        </div>

        {saved ? (
          <>
            <p className="rounded-xl border border-green-200 bg-green-50 p-3 text-xs text-green-900">
              {saved.claims} klaim dicatat. Buka raknya untuk menghitung atau memberi nama.
            </p>
            <Link
              href={`/dashboard/shop/${saved.postId}`}
              className="rounded-xl bg-brand py-2.5 text-center text-sm font-bold text-white"
            >
              Buka rak
            </Link>
          </>
        ) : (
          <>
            <label className="block cursor-pointer rounded-xl border border-dashed border-cream-border py-6 text-center text-xs text-gray-500">
              {file ? file.name : "Pilih atau tempel foto bertanda"}
              <input
                type="file"
                accept="image/*,.heic,.heif"
                className="sr-only"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null)
                  setMatch(null)
                }}
              />
            </label>

            <input
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              placeholder="instagram handle"
              className="border border-cream-border rounded-lg px-3 py-2 text-sm"
            />
            <input
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="catatan — size 95 mau 2"
              className="border border-cream-border rounded-lg px-3 py-2 text-sm"
            />

            {match ? (
              <p className="rounded-xl border border-cream-border bg-cream p-3 text-xs">
                Cocok dengan <b>{match.store || "rak tanpa nama"}</b> · {match.event} ·{" "}
                {match.marks} tanda
              </p>
            ) : null}
            {error ? <p className="text-xs text-red-600">{error}</p> : null}

            <button
              type="button"
              disabled={busy || !file || !customer.trim()}
              onClick={() => send(Boolean(match))}
              className="rounded-xl bg-brand py-2.5 text-sm font-bold text-white disabled:opacity-40"
            >
              {busy ? "Membaca…" : match ? `Catat ${match.marks || 1} klaim` : "Cari raknya"}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
