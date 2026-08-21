"use client"

import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement } from "react"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { useProductDefaults } from "@/hooks/useProductDefaults"
import EventSelect from "@/components/EventSelect"
import SearchableSelect from "@/components/SearchableSelect"
import SearchInput from "@/components/SearchInput"
import { useCopyFeedback } from "@/hooks/useCopyFeedback"
import { displayIg, fmt } from "@/lib/format"
import { formatIndonesianPhone } from "@/lib/format-phone"
import type { CatalogueRequest, ProductRow } from "@/lib/db"

/** Row action button, icon-only — matches list-order's copy/edit/delete
 *  convention (DataTable.tsx): neutral by default, colored only on hover. */
function IconActionButton({ onClick, disabled, label, hoverColor, icon }: {
  onClick: () => void
  disabled?: boolean
  label: string
  hoverColor: string
  icon: ReactElement
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center p-1.5 text-faint ${hoverColor} transition-colors rounded disabled:opacity-50`}
    >
      {icon}
    </button>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </svg>
  )
}

function EditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  )
}

/** Matches list-order's "Created At" column: a plain, compact timestamp,
 *  gray and small. CatalogueRequest.createdAt is a raw ISO string (unlike
 *  list-order's pre-formatted rows), so this formats it client-side. */
function requestedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("id-ID", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

const URL_PATTERN = /(https?:\/\/[^\s]+)/g
// A non-global twin for the per-part test below — reusing URL_PATTERN itself
// there would carry its lastIndex across calls (the `g` flag makes `.test`
// stateful) and silently skip every other real match.
const IS_URL = /^https?:\/\/[^\s]+$/

/** A custom request's description is free text a customer typed — often
 *  pasting a product link straight into it. Turns any http(s) URL in that
 *  text into a real link, opening in a new tab, without touching the rest
 *  of the text. */
function linkify(text: string): ReactElement {
  const parts = text.split(URL_PATTERN)
  return (
    <>
      {parts.map((part, i) =>
        IS_URL.test(part) ? (
          // eslint-disable-next-line react/no-array-index-key -- parts never reorder within one render
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-brand underline break-all">
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}

/** Finds the first URL in `text` and checks its hostname against `sites`
 *  (bare domains from Settings' Tier Kurs Sites field, migration 092) —
 *  exact match or a subdomain of one. Used to pre-select the Tier Kurs tab
 *  in "Propose a price revision" instead of always opening on Profit Margin. */
function matchesTierKursSite(text: string, sites: string[]): boolean {
  const match = text.match(IS_URL_SEARCH)
  if (!match) return false
  let hostname: string
  try {
    hostname = new URL(match[0]).hostname
  } catch {
    return false
  }
  hostname = hostname.replace(/^www\./, "")
  return sites.some((site) => hostname === site || hostname.endsWith(`.${site}`))
}
const IS_URL_SEARCH = /https?:\/\/[^\s]+/

const GROUP_FILTER_OPTIONS = [
  { value: "all", label: "All groups" },
  { value: "needs", label: "Needs your pick" },
  { value: "identity", label: "Unknown WhatsApp number" },
  { value: "custom", label: "Needs review" },
  { value: "ready", label: "Ready to convert" },
  { value: "other", label: "Closed / other" },
]

const SOURCE_FILTER_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "website", label: "Website" },
  { value: "custom", label: "Custom" },
]

function UserIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  )
}

function CameraIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  )
}

function TagIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" />
    </svg>
  )
}

function FollowUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 22V4a1 1 0 0 1 1-1h13.3a.7.7 0 0 1 .5 1.2L15 8l3.8 3.8a.7.7 0 0 1-.5 1.2H5a1 1 0 0 0-1 1" />
    </svg>
  )
}

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  )
}

function PaperclipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

function PackageIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  )
}

export default function OrderRequestsClient() {
  const options = useSheetOptions()
  const [requests, setRequests] = useState<CatalogueRequest[]>([])
  const [search, setSearch] = useState("")
  const [groupFilter, setGroupFilter] = useState<"all" | "needs" | "identity" | "custom" | "ready" | "other">("all")
  // Same three buckets as the Source badge (sourceBadge below): whatsapp,
  // catalogue+matched ("Website"), catalogue+unmatched ("Custom").
  const [sourceFilter, setSourceFilter] = useState<"all" | "whatsapp" | "website" | "custom">("all")
  // Both filters live behind one popover button — same convention as
  // Payments' mobile filter (checkedFilter/kindFilter).
  const [filterOpen, setFilterOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!filterOpen) return
    const h = (e: PointerEvent) => { if (!filterRef.current?.contains(e.target as Node)) setFilterOpen(false) }
    document.addEventListener("pointerdown", h)
    return () => document.removeEventListener("pointerdown", h)
  }, [filterOpen])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [countries, setCountries] = useState<{ id: number; name: string; kurs: number; cargoPerKg: number }[]>([])

  useEffect(() => {
    fetch("/api/sheets/products", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => setCountries(data.countries ?? []))
      .catch(() => {})
  }, [])

  const [convertingId, setConvertingId] = useState<number | null>(null)
  const [rejectingId, setRejectingId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [creatingProductForId, setCreatingProductForId] = useState<number | null>(null)
  const [provingId, setProvingId] = useState<number | null>(null)
  const [viewingImageUrl, setViewingImageUrl] = useState<string | null>(null)
  // Which row has its "Duplicate as variant" expand open — a size/color note
  // on an already-matched product needs its own SKU, and this is the inline
  // (Alt B) flow for making one without leaving the row. Only one open at a
  // time, same as every other per-row action here.
  const [duplicatingId, setDuplicatingId] = useState<number | null>(null)
  // Which row's "attach this WhatsApp number to a real customer" modal is
  // open — the fix for a claim whose sender never matched anyone at claim
  // time (see isUnresolvedIdentity below).
  const [linkingIdentityId, setLinkingIdentityId] = useState<number | null>(null)
  // Which row's status detail (offer/approval price, "asking in the group"
  // text, the candidate picker) is open in the status popup — moved out of
  // its own always-visible table column into a modal, so a row without
  // anything to say there doesn't carry a permanently empty cell.
  const [statusViewId, setStatusViewId] = useState<number | null>(null)
  const [selectedCandidate, setSelectedCandidate] = useState<Record<number, number>>({}) // requestId -> sendCodeId
  const [resolvingId, setResolvingId] = useState<number | null>(null)
  // Default view is pending-only (matches the API's default). Toggling shows
  // converted/rejected rows too — including WhatsApp closed-trip dead rows,
  // which never show up otherwise.
  const [showAll, setShowAll] = useState(false)

  async function reload() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/sheets/order-requests${showAll ? "?all=true" : ""}`, { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to load")
      setRequests(data.requests ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() }, [showAll])

  async function cancelEdit(id: number) {
    try {
      const res = await fetch(`/api/sheets/order-requests/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel-edit" }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel edit")
    }
  }

  async function resolveCandidate(r: CatalogueRequest): Promise<boolean> {
    const sendCodeId = selectedCandidate[r.id] ?? (r.candidates?.length === 1 ? r.candidates[0].id : undefined)
    if (sendCodeId === undefined) return false
    setResolvingId(r.id)
    try {
      const res = await fetch(`/api/sheets/order-requests/${r.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve-candidate", sendCodeId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      await reload()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve")
      return false
    } finally {
      setResolvingId(null)
    }
  }

  // A zero-candidate 'asking' row has nothing the bot could offer, but a
  // personal DM clearing up what she wants is a real, common resolution —
  // straight product assignment, no code/price snapshot involved.
  async function resolveManual(r: CatalogueRequest, productId: number): Promise<boolean> {
    setResolvingId(r.id)
    try {
      const res = await fetch(`/api/sheets/order-requests/${r.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve-manual", productId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      await reload()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve")
      return false
    } finally {
      setResolvingId(null)
    }
  }

  const converting = requests.find((r) => r.id === convertingId) ?? null
  const statusView = requests.find((r) => r.id === statusViewId) ?? null

  // createRejectedClaim's closed-trip dead rows are the only
  // 'rejected'+'whatsapp'+no-product rows stamped with this exact staffNote
  // (set verbatim in lib/db/catalogue-requests.ts) — an owner-rejected
  // direct claim always has productId set, and an owner-rejected
  // zero-candidate asking row (Tolak below) is also
  // 'rejected'+'whatsapp'+no-product but carries whatever staffNote the
  // owner typed (usually ""), so checking staffNote too keeps this label
  // scoped to the actual closed-trip case.
  function isDeadRow(r: CatalogueRequest): boolean {
    return r.status === "rejected" && r.source === "whatsapp" && r.productId === null
      && r.staffNote === "trip sudah tutup"
  }

  // A WhatsApp claim whose sender number never matched a customer falls
  // back to the bare phone number as its customer_handle (see
  // resolveCustomerHandle in worker/product-post.ts) — real Instagram
  // handles always contain a letter, so pure digits is the tell. Looks
  // exactly like a normal ready-to-convert row otherwise, right up until
  // Convert throws on it — surfaced here instead so it's caught before that.
  function isUnresolvedIdentity(r: CatalogueRequest): boolean {
    return r.source === "whatsapp" && /^\d+$/.test(r.customerHandle)
  }

  // Five groups instead of one flat list: what's stuck waiting on the
  // owner ('asking' — a candidate pick or a bare Tolak) surfaces first, a
  // custom request (no matched product yet, so nothing to check against)
  // needs its own look before it can be converted, a WhatsApp claim whose
  // sender was never matched to a customer needs that link made before
  // Convert will work at all, what's actually ready for a one-click
  // Convert comes next, and everything neither of those — waiting on the
  // customer, or already closed/rejected — last, since none of those need
  // the owner's attention right now.
  const q = search.trim().toLowerCase()
  const filteredRequests = requests
    .filter((r) =>
      sourceFilter === "all" ? true :
      sourceFilter === "whatsapp" ? r.source === "whatsapp" :
      sourceFilter === "website" ? r.source === "catalogue" && r.productId !== null :
      r.source === "catalogue" && r.productId === null,
    )
    .filter((r) =>
      !q ? true :
      r.customerHandle.toLowerCase().includes(q) ||
      (r.productName ?? "").toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q) ||
      r.note.toLowerCase().includes(q),
    )

  const needsPick = filteredRequests.filter((r) => r.status === "asking")
  // Only a 'pending' custom row still needs a price quotation — once it's
  // 'approved' (the customer confirmed a price, with or without a matched
  // product) it's no longer waiting on review, it's ready to convert.
  const needsCustomReview = filteredRequests.filter((r) => r.status === "pending" && r.productId === null)
  const needsIdentity = filteredRequests.filter((r) => (r.status === "pending" || r.status === "approved") && r.productId !== null && isUnresolvedIdentity(r))
  const readyToConvert = filteredRequests.filter((r) =>
    !isUnresolvedIdentity(r) && (r.status === "approved" || (r.status === "pending" && r.productId !== null)),
  )
  const otherRows = filteredRequests.filter((r) => r.status !== "asking" && r.status !== "pending" && r.status !== "approved")

  function showGroup(key: "needs" | "identity" | "custom" | "ready" | "other"): boolean {
    return groupFilter === "all" || groupFilter === key
  }
  const groupCounts = {
    needs: needsPick.length, identity: needsIdentity.length, custom: needsCustomReview.length,
    ready: readyToConvert.length, other: otherRows.length,
  }
  const visibleCount = groupFilter === "all" ? filteredRequests.length : groupCounts[groupFilter]

  function GroupRow({ dot, label, count }: { dot: "needs" | "custom" | "identity" | "ready" | "other"; label: string; count: number }) {
    return (
      <tr className="border-b border-cream-border bg-surface-muted/80">
        <td colSpan={7} className="px-4 py-2">
          <div className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${
              dot === "needs" ? "bg-amber-500" : dot === "custom" ? "bg-amber-500" : dot === "identity" ? "bg-red-500" : dot === "ready" ? "bg-green-600" : "bg-divider"
            }`} />
            <span className="text-[11px] font-semibold tracking-wide uppercase text-muted">{label}</span>
            <span className="text-[10px] font-semibold text-muted bg-surface-sunken rounded-full px-1.5 py-0.5">{count}</span>
          </div>
        </td>
      </tr>
    )
  }

  // Shared between the desktop table row and the mobile card — same badge
  // logic (source==='whatsapp' -> WhatsApp; unmatched -> Custom; matched ->
  // Website), just laid out differently by each caller.
  function sourceBadge(r: CatalogueRequest) {
    return r.source === "whatsapp" ? (
      <span className="inline-block px-1.5 py-0.5 rounded bg-green-100 text-green-700 text-[10px] font-medium">WhatsApp</span>
    ) : r.productId === null ? (
      <span className="inline-block px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-medium">Custom</span>
    ) : (
      <span className="inline-block px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px] font-medium">Website</span>
    )
  }

  function itemContent(r: CatalogueRequest) {
    return (
      <div className="min-w-0">
        <div className="text-foreground">
          {r.status === "asking" ? "—" : r.productId === null ? linkify(r.description) : r.productName}
          {r.resolvedCode && <span className="ml-1.5 font-mono font-bold text-brand text-xs">{r.resolvedCode}</span>}
        </div>
        {(r.note || r.referenceImageUrl) && (
          <div className="flex items-center gap-1">
            {r.note && <span className="text-xs text-faint">{linkify(r.note)}</span>}
            {r.referenceImageUrl && (
              <button
                type="button"
                onClick={() => setViewingImageUrl(r.referenceImageUrl)}
                title="Reference photo"
                className="inline-flex items-center justify-center shrink-0 p-1 text-faint hover:text-brand transition-colors rounded"
              >
                <CameraIcon />
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  // Matched product: its live current price. Unmatched custom request: the
  // estimate she was quoted, if any. Neither always applies, so this can
  // legitimately return null.
  function priceFor(r: CatalogueRequest): number | null {
    return r.productId !== null
      ? options?.items.find((it) => it.id === r.productId)?.price ?? null
      : r.estimatedPrice
  }

  // The full action-icon set for one row, status-branched — identical
  // between desktop and mobile, only the surrounding layout differs.
  function actionsFor(r: CatalogueRequest) {
    const dead = isDeadRow(r)
    return (
      <>
        {r.status === "asking" && (
          <IconActionButton onClick={() => setStatusViewId(r.id)} label="Tag product" hoverColor="hover:text-amber-600" icon={<FollowUpIcon />} />
        )}
        {(r.status === "offer_pending" || dead) && (
          <IconActionButton onClick={() => setStatusViewId(r.id)} label="Status" hoverColor="hover:text-amber-600" icon={<InfoIcon />} />
        )}
        {(r.status === "pending" || r.status === "approved") && isUnresolvedIdentity(r) && (
          <IconActionButton onClick={() => setLinkingIdentityId(r.id)} label="Link WhatsApp number to a customer" hoverColor="hover:text-red-500" icon={<UserIcon />} />
        )}
        {r.status === "pending" && (
          <>
            {r.productId !== null && !isUnresolvedIdentity(r) && (
              <IconActionButton
                onClick={() => setDuplicatingId(duplicatingId === r.id ? null : r.id)}
                label="Duplicate as variant"
                hoverColor="hover:text-brand"
                icon={<TagIcon />}
              />
            )}
            {r.productId === null && (
              <IconActionButton onClick={() => setEditingId(r.id)} label="Edit" hoverColor="hover:text-brand" icon={<EditIcon />} />
            )}
            {!isUnresolvedIdentity(r) && (
              <IconActionButton onClick={() => setConvertingId(r.id)} label="Convert" hoverColor="hover:text-green-600" icon={<CheckIcon />} />
            )}
            <IconActionButton onClick={() => setRejectingId(r.id)} label="Reject" hoverColor="hover:text-red-500" icon={<XIcon />} />
          </>
        )}
        {r.status === "offer_pending" && (
          <IconActionButton onClick={() => cancelEdit(r.id)} label="Cancel" hoverColor="hover:text-muted-strong" icon={<XIcon />} />
        )}
        {r.status === "approved" && (
          <>
            {!isUnresolvedIdentity(r) && (
              <IconActionButton onClick={() => setCreatingProductForId(r.id)} label="Create product & convert" hoverColor="hover:text-green-600" icon={<PackageIcon />} />
            )}
            <IconActionButton onClick={() => setStatusViewId(r.id)} label="Status" hoverColor="hover:text-amber-600" icon={<InfoIcon />} />
            <IconActionButton onClick={() => setRejectingId(r.id)} label="Reject" hoverColor="hover:text-red-500" icon={<XIcon />} />
          </>
        )}
        {r.status === "asking" && (
          <IconActionButton onClick={() => setRejectingId(r.id)} label="No reply" hoverColor="hover:text-red-500" icon={<XIcon />} />
        )}
        {(r.status === "converted" || r.status === "rejected") && (
          <span
            title={r.status === "converted" ? "Converted" : "Rejected"}
            className={`inline-flex items-center justify-center w-6 h-6 rounded-full ${
              r.status === "converted" ? "bg-green-100 text-green-600" : "bg-red-100 text-red-500"
            }`}
          >
            {r.status === "converted" ? <CheckIcon /> : <XIcon />}
          </span>
        )}
      </>
    )
  }

  function renderRow(r: CatalogueRequest) {
    const dead = isDeadRow(r)
    const price = priceFor(r)
    return (
      <Fragment key={r.id}>
      <tr className={`border-b border-cream-border align-top ${dead ? "opacity-60" : ""}`}>
        <td className="px-4 py-2.5">{sourceBadge(r)}</td>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-foreground">{displayIg(r.customerHandle)}</span>
          </div>
        </td>
        <td className="px-4 py-2.5">{itemContent(r)}</td>
        <td className="px-4 py-2.5 text-right tabular-nums text-foreground">{r.qty}</td>
        <td className="px-4 py-2.5 text-right tabular-nums text-foreground whitespace-nowrap">
          {price !== null ? fmt(price) : <span className="text-faint">—</span>}
        </td>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-1">
            <span className="text-faint text-xs whitespace-nowrap">{requestedAt(r.createdAt)}</span>
            {r.source === "whatsapp" && (
              <IconActionButton
                onClick={() => setProvingId(r.id)}
                label="Bukti pesan WhatsApp"
                hoverColor="hover:text-amber-600"
                icon={<PaperclipIcon />}
              />
            )}
          </div>
        </td>
        <td className="px-4 py-2.5">
          <div className="flex gap-2 justify-end flex-wrap">{actionsFor(r)}</div>
        </td>
      </tr>
      {duplicatingId === r.id && (
        <DuplicateVariantRow
          request={r}
          activeEvents={options?.activeEvents ?? []}
          onClose={() => setDuplicatingId(null)}
          onDone={() => { setDuplicatingId(null); reload() }}
        />
      )}
      </Fragment>
    )
  }

  function renderCard(r: CatalogueRequest) {
    const dead = isDeadRow(r)
    const price = priceFor(r)
    return (
      <div key={r.id} className={`flex flex-col gap-2 ${dead ? "opacity-60" : ""}`}>
        <div className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <span className="font-semibold text-sm text-foreground uppercase truncate">{displayIg(r.customerHandle)}</span>
            {sourceBadge(r)}
          </div>
          <div className="flex items-start justify-between gap-3 mt-2">
            <div className="text-sm text-foreground min-w-0">
              {r.status === "asking" ? "—" : r.productId === null ? linkify(r.description) : r.productName}
              {r.resolvedCode && <span className="ml-1.5 font-mono font-bold text-brand text-xs">{r.resolvedCode}</span>}
            </div>
            <div className="shrink-0 flex items-center gap-0 flex-wrap justify-end -mr-1">{actionsFor(r)}</div>
          </div>
          {(r.note || r.referenceImageUrl) && (
            <div className="flex items-center gap-1 mt-1">
              {r.note && <span className="text-xs text-faint italic">{linkify(r.note)}</span>}
              {r.referenceImageUrl && (
                <IconActionButton
                  onClick={() => setViewingImageUrl(r.referenceImageUrl)}
                  label="Reference photo"
                  hoverColor="hover:text-brand"
                  icon={<CameraIcon />}
                />
              )}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-cream-border">
            <div className="flex items-center gap-1">
              <span className="text-xs text-faint whitespace-nowrap">{requestedAt(r.createdAt)}</span>
              {r.source === "whatsapp" && (
                <IconActionButton
                  onClick={() => setProvingId(r.id)}
                  label="Bukti pesan WhatsApp"
                  hoverColor="hover:text-amber-600"
                  icon={<PaperclipIcon />}
                />
              )}
            </div>
            <div className="flex items-center gap-2">
              {price !== null && <span className="text-sm font-semibold text-foreground tabular-nums whitespace-nowrap">Rp {fmt(price)}</span>}
              <span className="shrink-0 inline-flex items-center justify-center h-5 w-9 rounded-full text-[11px] font-bold bg-brand text-white">× {r.qty}</span>
            </div>
          </div>
        </div>
        {duplicatingId === r.id && (
          <DuplicateVariantCard
            request={r}
            activeEvents={options?.activeEvents ?? []}
            onClose={() => setDuplicatingId(null)}
            onDone={() => { setDuplicatingId(null); reload() }}
          />
        )}
      </div>
    )
  }

  function MobileGroupHeader({ dot, label, count }: { dot: "needs" | "custom" | "identity" | "ready" | "other"; label: string; count: number }) {
    return (
      <div className="flex items-center gap-2 px-0.5 pt-1 first:pt-0">
        <span className={`w-1.5 h-1.5 rounded-full ${
          dot === "needs" ? "bg-amber-500" : dot === "custom" ? "bg-amber-500" : dot === "identity" ? "bg-red-500" : dot === "ready" ? "bg-green-600" : "bg-divider"
        }`} />
        <span className="text-[11px] font-semibold tracking-wide uppercase text-muted">{label}</span>
        <span className="text-[10px] font-semibold text-muted bg-surface-sunken rounded-full px-1.5 py-0.5">{count}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Search customer, item, note…" className="flex-1" />
        <div className="relative shrink-0" ref={filterRef}>
          <button
            type="button"
            onClick={() => setFilterOpen((o) => !o)}
            aria-label="Filters"
            className="h-full border border-cream-border rounded-lg px-3 py-2 text-sm text-muted-strong bg-white flex items-center gap-1.5 hover:border-brand transition-colors"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
            {(groupFilter !== "all" || sourceFilter !== "all") && <span className="w-1.5 h-1.5 rounded-full bg-brand" />}
          </button>
          {filterOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 w-52 rounded-lg border border-cream-border bg-white shadow-lg p-3 flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">Group</span>
                <div className="flex flex-col gap-0.5">
                  {GROUP_FILTER_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => setGroupFilter(o.value as typeof groupFilter)}
                      className={`text-left px-2 py-1.5 rounded-lg text-xs transition-colors ${
                        groupFilter === o.value ? "bg-brand/10 text-brand font-medium" : "text-muted-strong hover:bg-surface-muted"
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">Source</span>
                <div className="flex flex-col gap-0.5">
                  {SOURCE_FILTER_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => setSourceFilter(o.value as typeof sourceFilter)}
                      className={`text-left px-2 py-1.5 rounded-lg text-xs transition-colors ${
                        sourceFilter === o.value ? "bg-brand/10 text-brand font-medium" : "text-muted-strong hover:bg-surface-muted"
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          aria-label={showAll ? "Back to active requests" : "Show closed/converted requests too"}
          title={showAll ? "Showing all requests" : "Showing only active requests"}
          className={`shrink-0 rounded-lg border px-3 py-2 ${
            showAll ? "border-brand bg-brand/5 text-brand" : "border-cream-border bg-white text-faint"
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="5" rx="1" />
            <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
            <path d="M10 12h4" />
          </svg>
        </button>
      </div>
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {loading ? (
        <p className="text-sm text-faint">Loading…</p>
      ) : visibleCount === 0 ? (
        <p className="text-sm text-faint">
          {search || groupFilter !== "all" || sourceFilter !== "all" ? "No requests match your search/filter." : "No pending requests."}
        </p>
      ) : (
        <>
        {/* Desktop table */}
        <div className="hidden md:block rounded-xl border border-cream-border bg-white overflow-hidden overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-cream-border bg-surface-muted/80">
                <th className="text-left px-4 py-2.5 font-medium text-muted w-28">Source</th>
                <th className="text-left px-4 py-2.5 font-medium text-muted w-40">Customer</th>
                <th className="text-left px-4 py-2.5 font-medium text-muted">Item / Note</th>
                <th className="text-right px-4 py-2.5 font-medium text-muted w-16">Qty</th>
                <th className="text-right px-4 py-2.5 font-medium text-muted w-28">Price</th>
                <th className="text-left px-4 py-2.5 font-medium text-muted w-28">Requested At</th>
                <th className="px-4 py-2.5 w-60" />
              </tr>
            </thead>
            <tbody>
              {showGroup("needs") && needsPick.length > 0 && (
                <>
                  <GroupRow dot="needs" label="Needs your pick" count={needsPick.length} />
                  {needsPick.map((r) => renderRow(r))}
                </>
              )}
              {showGroup("identity") && needsIdentity.length > 0 && (
                <>
                  <GroupRow dot="identity" label="Unknown WhatsApp number" count={needsIdentity.length} />
                  {needsIdentity.map((r) => renderRow(r))}
                </>
              )}
              {showGroup("custom") && needsCustomReview.length > 0 && (
                <>
                  <GroupRow dot="custom" label="Needs review" count={needsCustomReview.length} />
                  {needsCustomReview.map((r) => renderRow(r))}
                </>
              )}
              {showGroup("ready") && readyToConvert.length > 0 && (
                <>
                  <GroupRow dot="ready" label="Ready to convert" count={readyToConvert.length} />
                  {readyToConvert.map((r) => renderRow(r))}
                </>
              )}
              {showGroup("other") && otherRows.length > 0 && (
                <>
                  <GroupRow dot="other" label="Closed / other" count={otherRows.length} />
                  {otherRows.map((r) => renderRow(r))}
                </>
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="md:hidden flex flex-col gap-2">
          {showGroup("needs") && needsPick.length > 0 && (
            <>
              <MobileGroupHeader dot="needs" label="Needs your pick" count={needsPick.length} />
              {needsPick.map((r) => renderCard(r))}
            </>
          )}
          {showGroup("identity") && needsIdentity.length > 0 && (
            <>
              <MobileGroupHeader dot="identity" label="Unknown WhatsApp number" count={needsIdentity.length} />
              {needsIdentity.map((r) => renderCard(r))}
            </>
          )}
          {showGroup("custom") && needsCustomReview.length > 0 && (
            <>
              <MobileGroupHeader dot="custom" label="Needs review" count={needsCustomReview.length} />
              {needsCustomReview.map((r) => renderCard(r))}
            </>
          )}
          {showGroup("ready") && readyToConvert.length > 0 && (
            <>
              <MobileGroupHeader dot="ready" label="Ready to convert" count={readyToConvert.length} />
              {readyToConvert.map((r) => renderCard(r))}
            </>
          )}
          {showGroup("other") && otherRows.length > 0 && (
            <>
              <MobileGroupHeader dot="other" label="Closed / other" count={otherRows.length} />
              {otherRows.map((r) => renderCard(r))}
            </>
          )}
        </div>
        </>
      )}
      {converting && (
        <ConvertModal
          requestId={converting.id}
          needsProduct={converting.productId === null}
          events={options?.activeEvents ?? []}
          items={options?.items ?? []}
          // A WhatsApp row's trip is authoritatively known (wa_sends.event,
          // via resolvedEvent) — never the highlight-derived defaultEvent,
          // which is always null for a WhatsApp row anyway (post_id is
          // always null there). Locked, not just defaulted, for that same
          // reason: this isn't a suggestion to override, it's the trip the
          // claim was actually made against. See finding 4.
          defaultEvent={converting.source === "whatsapp" ? converting.resolvedEvent : converting.defaultEvent}
          lockEvent={converting.source === "whatsapp" && converting.resolvedEvent !== null}
          onClose={() => setConvertingId(null)}
          onDone={() => { setConvertingId(null); reload() }}
        />
      )}
      {statusView && (
        <StatusModal
          request={statusView}
          dead={isDeadRow(statusView)}
          items={options?.items ?? []}
          selectedCandidate={selectedCandidate}
          onSelectCandidate={(sendCodeId) => setSelectedCandidate((s) => ({ ...s, [statusView.id]: sendCodeId }))}
          resolving={resolvingId === statusView.id}
          onResolve={() => resolveCandidate(statusView).then((ok) => { if (ok) setStatusViewId(null) })}
          onResolveManual={(productId) => resolveManual(statusView, productId).then((ok) => { if (ok) setStatusViewId(null) })}
          onClose={() => setStatusViewId(null)}
        />
      )}
      {rejectingId != null && (
        <RejectModal
          requestId={rejectingId}
          onClose={() => setRejectingId(null)}
          onDone={() => { setRejectingId(null); reload() }}
        />
      )}
      {editingId != null && (() => {
        const req = requests.find((r) => r.id === editingId)
        return req ? (
          <EditModal
            request={req}
            countries={countries}
            onClose={() => setEditingId(null)}
            onDone={() => { setEditingId(null); reload() }}
          />
        ) : null
      })()}
      {linkingIdentityId != null && (() => {
        const req = requests.find((r) => r.id === linkingIdentityId)
        return req ? (
          <LinkIdentityModal
            request={req}
            onClose={() => setLinkingIdentityId(null)}
            onDone={() => { setLinkingIdentityId(null); reload() }}
          />
        ) : null
      })()}
      {creatingProductForId != null && (() => {
        const req = requests.find((r) => r.id === creatingProductForId)
        return req ? (
          <CreateProductModal
            request={req}
            countries={countries}
            activeEvents={options?.activeEvents ?? []}
            onClose={() => setCreatingProductForId(null)}
            onDone={() => { setCreatingProductForId(null); reload() }}
          />
        ) : null
      })()}
      {provingId != null && (() => {
        const req = requests.find((r) => r.id === provingId)
        return req ? <ProofModal request={req} onClose={() => setProvingId(null)} /> : null
      })()}
      {viewingImageUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setViewingImageUrl(null)}>
          <div className="relative max-w-2xl max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setViewingImageUrl(null)}
              aria-label="Close"
              className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-white text-foreground flex items-center justify-center shadow-lg"
            >
              <XIcon />
            </button>
            <img src={viewingImageUrl} alt="Reference photo" className="max-w-full max-h-[90vh] rounded-lg object-contain" />
          </div>
        </div>
      )}
    </div>
  )
}

function ProofModal({ request, onClose }: { request: CatalogueRequest; onClose: () => void }) {
  const { copied, copy } = useCopyFeedback()

  const number = request.sender.split("@")[0]?.split(":")[0]?.replace(/\D/g, "") ?? ""
  const phone = formatIndonesianPhone(number)
  const sentAt = new Date(request.createdAt)
  const dateStr = sentAt.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })
  const timeStr = sentAt.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })
  const textExport = [
    displayIg(request.customerHandle),
    phone,
    `${dateStr}, ${timeStr}`,
    request.resolvedEvent ? `Grup: ${request.resolvedEvent}` : null,
    "",
    `"${request.note}"`,
  ].filter((line) => line !== null).join("\n")

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl p-5 w-full max-w-sm flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Timestamp</h3>
          <button onClick={onClose} className="text-faint hover:text-foreground text-lg leading-none">&times;</button>
        </div>
        <pre className="whitespace-pre-wrap font-mono text-xs bg-surface-muted border border-cream-border rounded-lg p-3">
          {textExport}
        </pre>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => copy(textExport)}
            aria-label={copied ? "Tersalin" : "Salin teks"}
            title={copied ? "Tersalin ✓" : "Salin teks"}
            className={`w-9 h-9 rounded-lg border border-cream-border flex items-center justify-center ${copied ? "text-green-600" : "text-muted"}`}
          >
            {copied ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
          <a
            href={`/api/sheets/order-requests/${request.id}/proof-image`}
            download={`bukti-pesan-${request.id}.png`}
            aria-label="Unduh screenshot"
            title="Unduh screenshot"
            className="w-9 h-9 rounded-lg bg-brand text-white flex items-center justify-center"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </a>
        </div>
      </div>
    </div>
  )
}

function ConvertModal({ requestId, needsProduct, events, items, defaultEvent, lockEvent = false, onClose, onDone }: {
  requestId: number
  needsProduct: boolean
  events: string[]
  items: { id: number; name: string; store: string; price: number; active: boolean }[]
  defaultEvent: string | null
  // True for a WhatsApp row whose trip is authoritatively known
  // (resolvedEvent), not just suggested — locks the picker instead of only
  // pre-filling it. See finding 4.
  lockEvent?: boolean
  onClose: () => void
  onDone: () => void
}) {
  // A locked WhatsApp trip is used verbatim, even if it isn't in the active
  // events list (e.g. the trip has since closed) — unlike the highlight-
  // derived suggestion below, this isn't a guess that needs validating
  // against "currently open for purchasing."
  const [event, setEvent] = useState(() =>
    lockEvent && defaultEvent
      ? defaultEvent
      : (defaultEvent && events.includes(defaultEvent)) ? defaultEvent : "",
  )
  const [productId, setProductId] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  // The picker's own option list must include a locked-but-inactive event,
  // or SearchableSelect has no label to show for it and the locked box
  // renders blank even though `event` state is correctly set.
  const eventOptions = useMemo(
    () => (lockEvent && event && !events.includes(event)) ? [...events, event] : events,
    [events, lockEvent, event],
  )

  const itemOptions = useMemo(
    () => items.filter((it) => it.active).map((it) => ({
      value: String(it.id),
      label: it.name,
      meta: `Rp ${fmt(it.price)}`,
    })),
    [items],
  )

  async function submit() {
    if (!event) { setError("Pick an event"); return }
    if (needsProduct && !productId) { setError("Pick a product for this custom request"); return }
    setSubmitting(true); setError("")
    try {
      const res = await fetch(`/api/sheets/order-requests/${requestId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "convert",
          event,
          ...(needsProduct ? { productId: Number(productId) } : {}),
        }),
      })
      const data = await res.json()
      // 409 = someone else already converted/rejected this request (guard
      // violation); 400 = validation problem (missing event, or a custom
      // request converted without picking a product). Surfaced identically
      // via the same error message, both are user-actionable, not crashes.
      if (!res.ok) throw new Error(data.error ?? "Failed")
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl p-5 w-full max-w-sm flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-foreground">Convert to order</h3>
        <EventSelect value={event} onChange={setEvent} events={eventOptions} placeholder="Select event…" disabled={lockEvent} />
        {lockEvent && (
          <p className="text-xs text-faint">Trip terkunci — sudah diketahui dari klaim WhatsApp-nya.</p>
        )}
        {needsProduct && (
          <SearchableSelect
            value={productId}
            onChange={setProductId}
            options={itemOptions}
            placeholder="Search product for this custom request…"
          />
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Convert"}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Shared state/logic behind "duplicate the matched product as its own SKU" —
 * a size/colour note on an already-priced product ("Navy, size L") isn't
 * itself sellable until it has its own product row. Fetches the matched
 * product's FULL pricing row and re-POSTs every field unchanged except name,
 * so the duplicate reproduces the same price under whichever pricing method
 * the source uses (computeProductPrice recomputes it from those same inputs
 * — see lib/pricing-server.ts). One button then also converts this request
 * straight onto the new product, closing the loop without a second trip
 * through the normal Convert modal. Two presentational shells below reuse
 * this hook: an inline expanding table row on desktop, a stacked card on
 * mobile — same fields, same submit, different layout.
 */
function useDuplicateVariant(request: CatalogueRequest, onDone: () => void) {
  const [product, setProduct] = useState<ProductRow | null>(null)
  const [loadError, setLoadError] = useState("")
  const [name, setName] = useState("")
  const lockEvent = request.source === "whatsapp" && request.resolvedEvent !== null
  const [event, setEvent] = useState(
    (request.source === "whatsapp" ? request.resolvedEvent : request.defaultEvent) ?? "",
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (request.productId === null) return
    fetch(`/api/sheets/products/${request.productId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error)
        const p: ProductRow = data.product
        setProduct(p)
        setName(request.note.trim() ? `${p.name} — ${request.note.trim()}` : p.name)
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load product"))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.productId])

  async function submit() {
    if (!product) return
    if (!name.trim()) { setError("Name is required"); return }
    if (!event) { setError("Pick an event"); return }
    setSubmitting(true); setError("")
    try {
      const productRes = await fetch("/api/sheets/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          store: product.store,
          pricingMethod: product.pricingMethod,
          flatFeeMode: product.flatFeeMode,
          countryId: product.countryId,
          valas: product.valas,
          gram: product.gram,
          kurs: product.kurs,
          cargoPerKg: product.cargoPerKg,
          profitPct: product.profitPct,
          operationalFee: product.operationalFee,
          packingFee: product.packingFee,
          cost: product.cost,
          profitFixed: product.profitFixed,
          price: product.price,
        }),
      })
      const productData = await productRes.json()
      if (!productRes.ok) throw new Error(productData.error ?? "Failed to create product")

      const convertRes = await fetch(`/api/sheets/order-requests/${request.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "convert", event, productId: productData.id }),
      })
      const convertData = await convertRes.json()
      if (!convertRes.ok) throw new Error(convertData.error ?? "Failed to convert")
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setSubmitting(false)
    }
  }

  return { product, loadError, name, setName, lockEvent, event, setEvent, submitting, error, submit }
}

function DuplicateVariantFields({ dv, activeEvents, onClose }: {
  dv: ReturnType<typeof useDuplicateVariant>
  activeEvents: string[]
  onClose: () => void
}) {
  const { product, loadError, name, setName, lockEvent, event, setEvent, submitting, error, submit } = dv
  if (loadError) return <p className="text-xs text-red-500">{loadError}</p>
  if (!product) return <p className="text-xs text-faint">Loading…</p>
  // A locked-but-inactive event must be in the picker's own option list, or
  // SearchableSelect has no label to show for it and the locked box renders
  // blank even though `event` state is correctly set — same fix ConvertModal
  // already needed for this exact case.
  const eventOptions = (lockEvent && event && !activeEvents.includes(event)) ? [...activeEvents, event] : activeEvents
  return (
    <div className="flex flex-col gap-2">
      <label className="text-[10px] font-semibold uppercase tracking-wide text-muted">
        New product name — price · store · weight copied from {product.name}
      </label>
      <div className="flex flex-col md:flex-row md:items-center gap-2">
        <div className="w-full md:w-28 h-10 shrink-0 px-2 rounded-lg border border-cream-border bg-surface-muted text-muted text-sm flex items-center truncate" title="Store (copied)">
          {product.store || "—"}
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 h-10 border border-cream-border rounded-lg px-2 text-sm bg-white"
        />
        <div className="w-full md:w-32 h-10 shrink-0 px-2 rounded-lg border border-cream-border bg-surface-muted text-muted text-sm flex items-center" title="Price (copied)">
          <span>Rp</span>
          <span className="ml-auto tabular-nums">{fmt(product.price)}</span>
        </div>
        <div className="w-full md:w-40 h-10 shrink-0">
          <EventSelect value={event} onChange={setEvent} events={eventOptions} placeholder="Event…" disabled={lockEvent} />
        </div>
        <div className="flex gap-2">
          <button onClick={onClose} className="h-10 px-3 rounded-lg border border-cream-border text-xs shrink-0 flex-1 md:flex-none">Cancel</button>
          <button onClick={submit} disabled={submitting} className="h-10 px-3 rounded-lg bg-brand text-white text-xs disabled:opacity-50 shrink-0 whitespace-nowrap flex-1 md:flex-none">
            {submitting ? "Saving…" : "Create & convert"}
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}

function DuplicateVariantRow({ request, activeEvents, onClose, onDone }: {
  request: CatalogueRequest
  activeEvents: string[]
  onClose: () => void
  onDone: () => void
}) {
  const dv = useDuplicateVariant(request, onDone)
  return (
    <tr className="border-b border-cream-border bg-brand-light/40">
      <td colSpan={7} className="px-4 py-3">
        <DuplicateVariantFields dv={dv} activeEvents={activeEvents} onClose={onClose} />
      </td>
    </tr>
  )
}

function DuplicateVariantCard({ request, activeEvents, onClose, onDone }: {
  request: CatalogueRequest
  activeEvents: string[]
  onClose: () => void
  onDone: () => void
}) {
  const dv = useDuplicateVariant(request, onDone)
  return (
    <div className="rounded-xl border border-cream-border bg-brand-light/40 p-3 -mt-1">
      <DuplicateVariantFields dv={dv} activeEvents={activeEvents} onClose={onClose} />
    </div>
  )
}

/**
 * What the old always-visible Status column used to show, moved behind the
 * status icon instead — a row with nothing to say there no longer carries a
 * permanently empty cell. For an 'asking' row with candidates, this is also
 * where the candidate is actually picked: the row itself only offers the
 * flag (open this modal) and reject — picking a candidate happens here.
 */
function StatusModal({ request, dead, items, selectedCandidate, onSelectCandidate, resolving, onResolve, onResolveManual, onClose }: {
  request: CatalogueRequest
  dead: boolean
  items: { id: number; name: string; store: string; price: number; active: boolean }[]
  selectedCandidate: Record<number, number>
  onSelectCandidate: (sendCodeId: number) => void
  resolving: boolean
  onResolve: () => void
  onResolveManual: (productId: number) => void
  onClose: () => void
}) {
  const candidates = request.candidates ?? []
  const [manualProductId, setManualProductId] = useState("")
  const itemOptions = useMemo(
    () => items.filter((it) => it.active).map((it) => ({ value: String(it.id), label: it.name, meta: `Rp ${fmt(it.price)}` })),
    [items],
  )
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl p-5 w-full max-w-sm flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-foreground">Status</h3>
        {request.status === "offer_pending" && (
          <p className="text-xs text-amber-600 font-medium">
            Menunggu persetujuan — {request.countryName} · valas {request.valas} · {request.gram}g · Rp {fmt(request.estimatedPrice ?? 0)}
          </p>
        )}
        {request.status === "approved" && (
          <p className="text-xs text-green-600 font-medium">
            Approved ✓ — {request.countryName} · valas {request.valas} · {request.gram}g · Rp {fmt(request.estimatedPrice ?? 0)}
          </p>
        )}
        {dead && <p className="text-xs text-faint">Trip sudah tutup — tidak dicatat</p>}
        {request.status === "asking" && candidates.length === 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-amber-600 font-medium">Ditanya di grup — belum ada kandidat</p>
            <p className="text-xs text-muted">
              If she confirmed what she wants over DM, pick the product directly — no candidate code needed.
            </p>
            <SearchableSelect value={manualProductId} onChange={setManualProductId} options={itemOptions} placeholder="Search product…" />
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Close</button>
              <button
                onClick={() => onResolveManual(Number(manualProductId))}
                disabled={resolving || !manualProductId}
                className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50"
              >
                {resolving ? "Menyimpan…" : "Assign"}
              </button>
            </div>
          </div>
        )}
        {request.status === "asking" && candidates.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-amber-600 font-medium">
              {candidates.length === 1 ? "Ditanya di grup — menunggu 👍" : "Ditanya di grup — beberapa kemungkinan"}
            </p>
            <div className="flex flex-col gap-1">
              {candidates.map((c, i) => {
                const isSelected = selectedCandidate[request.id] === c.id || (candidates.length === 1 && selectedCandidate[request.id] === undefined && i === 0)
                return (
                  <label
                    key={c.id}
                    className={`flex items-center gap-2 border rounded-lg px-2 py-1.5 text-xs cursor-pointer ${isSelected ? "border-brand ring-1 ring-brand" : "border-cream-border"}`}
                  >
                    <input
                      type="radio"
                      name={`candidate-${request.id}`}
                      checked={isSelected}
                      onChange={() => onSelectCandidate(c.id)}
                      className="accent-brand"
                    />
                    <span className="font-mono font-bold text-brand">{c.code}</span>
                    <span>{c.productName}</span>
                    <span className="ml-auto text-muted">Rp {c.price.toLocaleString("id-ID")}</span>
                  </label>
                )
              })}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Close</button>
              <button
                onClick={onResolve}
                disabled={resolving || (candidates.length !== 1 && selectedCandidate[request.id] === undefined)}
                className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50"
              >
                {resolving ? "Menyimpan…" : "Pilih"}
              </button>
            </div>
          </div>
        )}
        {request.status !== "asking" && (
          <div className="flex justify-end">
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Close</button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Attach an unresolved WhatsApp claim's phone number to a real customer.
 * Search is name/handle over the full customer list (same source the
 * Products/Orders pages already fetch from) — there's no dedicated search
 * endpoint for this, and the list is small enough that fetching it whole
 * and filtering client-side is fine.
 */
function LinkIdentityModal({ request, onClose, onDone }: {
  request: CatalogueRequest
  onClose: () => void
  onDone: () => void
}) {
  const [customers, setCustomers] = useState<{ instagramId: string; name: string }[] | null>(null)
  const [handle, setHandle] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    fetch("/api/sheets/customers", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => setCustomers(data.rows ?? []))
      .catch(() => setCustomers([]))
  }, [])

  const options = useMemo(
    () => (customers ?? []).map((c) => ({ value: c.instagramId, label: c.name ? `${c.name} (@${c.instagramId})` : `@${c.instagramId}` })),
    [customers],
  )

  async function submit() {
    if (!handle) { setError("Pick a customer"); return }
    setSubmitting(true); setError("")
    try {
      const res = await fetch(`/api/sheets/order-requests/${request.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve-identity", handle }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl p-5 w-full max-w-sm flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-foreground">Link WhatsApp number to a customer</h3>
        <p className="text-xs text-muted">
          Number <span className="font-mono">{request.customerHandle}</span> couldn't be matched automatically. Pick who this actually is.
        </p>
        <SearchableSelect
          value={handle}
          onChange={setHandle}
          options={options}
          placeholder={customers === null ? "Loading…" : "Search customer…"}
          disabled={customers === null}
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting || !handle} className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Link"}
          </button>
        </div>
      </div>
    </div>
  )
}

function RejectModal({ requestId, onClose, onDone }: {
  requestId: number
  onClose: () => void
  onDone: () => void
}) {
  const [staffNote, setStaffNote] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  async function submit() {
    setSubmitting(true); setError("")
    try {
      const res = await fetch(`/api/sheets/order-requests/${requestId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", staffNote }),
      })
      const data = await res.json()
      // Same 409-on-guard-violation handling as ConvertModal above.
      if (!res.ok) throw new Error(data.error ?? "Failed")
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl p-5 w-full max-w-sm flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-foreground">Reject request</h3>
        <input
          value={staffNote}
          onChange={(e) => setStaffNote(e.target.value)}
          placeholder="Note the customer will see (optional)"
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Reject"}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Looks like Add Product's Profit Margin tab — same fields, same layout —
 *  because proposing a price for a custom request IS that same formula, just
 *  landing on a catalogue_requests row instead of a products row. Prefilled
 *  from the request's own prior country/valas/gram when present (a re-edit),
 *  and from Settings' product defaults for profit%/fees, exactly like a
 *  fresh Add Product form does. */
function EditModal({ request, countries, onClose, onDone }: {
  request: CatalogueRequest
  countries: { id: number; name: string; kurs: number; cargoPerKg: number }[]
  onClose: () => void
  onDone: () => void
}) {
  const productDefaults = useProductDefaults()
  // This modal always opens on a fresh 'pending' row (cancel-edit resets
  // proposedPricingMethod back to 'overseas' — see cancelEditCatalogueRequest),
  // so there's no prior method to restore here.
  const [pricingMethod, setPricingMethod] = useState<"overseas" | "tier_kurs">("overseas")
  // Prefilled from what she typed, editable — this becomes the product's
  // actual name on convert, kept separate from `description` (migration 093)
  // so her original text survives even if the owner renames it here. Store
  // isn't collected here — it doesn't affect price, and the owner often
  // hasn't sourced the item yet at quotation time; it's asked for at
  // Create Product & convert instead, right before the product row exists.
  const [name, setName] = useState(request.description)
  const [countryId, setCountryId] = useState(request.countryId !== null ? String(request.countryId) : "")
  const [valas, setValas] = useState(request.valas !== null ? String(request.valas) : "")
  const [gram, setGram] = useState(request.gram !== null ? String(request.gram) : "")
  // Starts at the DB column defaults (matches DEFAULT_PRODUCT_DEFAULTS in
  // lib/product-defaults.ts) so there's no flash of 0/0/0 before Settings'
  // customRequest* fields load (migration 090) and overwrite these below —
  // same convention AddProductForm already uses for its own defaults.
  // Meant to mirror the customer-facing form's own live-estimate formula,
  // so with country/valas/gram unchanged from what she submitted, the live
  // Price below reads the same number she was quoted until the owner
  // actually decides to change the terms. Only meaningful for 'overseas' —
  // Tier Kurs has no profit%/op fee, the rate spread IS the margin.
  const [profitPct, setProfitPct] = useState("15")
  const [opFee, setOpFee] = useState("5000")
  const [packFee, setPackFee] = useState("0")
  const [preview, setPreview] = useState<number | null>(null)
  const [profitPreview, setProfitPreview] = useState<number | null>(null)
  // Only populated under Tier Kurs — the rate actually resolved from
  // country_kurs_tiers for this valas amount, server-side, read-only.
  const [tieredKursPreview, setTieredKursPreview] = useState<number | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  // Country only fills in when the row has none at all (a legacy request
  // from before migration 088 carried it through) — never overwrites what
  // she actually picked. Profit%/fees always start from Settings — this
  // modal always opens fresh (no prior partial edit to preserve).
  useEffect(() => {
    if (!productDefaults) return
    if (!countryId && productDefaults.defaultCountryId !== null) {
      setCountryId(String(productDefaults.defaultCountryId))
    }
    setProfitPct(String(productDefaults.customRequestProfitPct))
    setOpFee(String(productDefaults.customRequestOperationalFee))
    setPackFee(String(productDefaults.customRequestPackingFee))
    // A URL in the description/note matching a Settings-configured Tier Kurs
    // site (migration 092) pre-selects that tab instead of always opening on
    // Profit Margin — this modal always opens fresh, so there's no manual
    // choice this could clobber.
    if (
      matchesTierKursSite(request.description, productDefaults.tierKursSites) ||
      matchesTierKursSite(request.note, productDefaults.tierKursSites)
    ) {
      setPricingMethod("tier_kurs")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productDefaults])

  const countryOptions = useMemo(
    () => countries.map((c) => ({ value: String(c.id), label: c.name })),
    [countries],
  )

  useEffect(() => {
    const cId = Number(countryId)
    const v = Number(valas)
    const g = Number(gram)
    const p = Number(profitPct)
    const op = Number(opFee)
    const pack = Number(packFee)
    const overseasFieldsInvalid = pricingMethod === "overseas" && (!(p >= 0) || !(op >= 0))
    if (!cId || !(v > 0) || !(g > 0) || !(pack >= 0) || overseasFieldsInvalid) {
      setPreview(null); setProfitPreview(null); setTieredKursPreview(null)
      return
    }
    const t = setTimeout(async () => {
      setPreviewLoading(true)
      try {
        const qs = new URLSearchParams({ countryId: String(cId), valas: String(v), gram: String(g), packingFee: String(pack), pricingMethod })
        if (pricingMethod === "overseas") {
          qs.set("profitPct", String(p))
          qs.set("operationalFee", String(op))
        }
        const res = await fetch(`/api/sheets/order-requests/preview-price?${qs}`)
        const data = await res.json()
        setPreview(res.ok ? data.estimatedPrice : null)
        setProfitPreview(res.ok ? data.profit : null)
        setTieredKursPreview(res.ok ? data.tieredKurs ?? null : null)
      } catch {
        setPreview(null)
        setProfitPreview(null)
        setTieredKursPreview(null)
      } finally {
        setPreviewLoading(false)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [pricingMethod, countryId, valas, gram, profitPct, opFee, packFee])

  async function submit() {
    if (!name.trim()) { setError("Name is required"); return }
    if (!countryId) { setError("Pick a country"); return }
    if (!(Number(valas) > 0)) { setError("Enter a valid valas amount"); return }
    if (!(Number(gram) > 0)) { setError("Enter a valid weight"); return }
    setSubmitting(true); setError("")
    try {
      const res = await fetch(`/api/sheets/order-requests/${request.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "edit",
          name: name.trim(),
          countryId: Number(countryId),
          valas: Number(valas),
          gram: Number(gram),
          pricingMethod,
          packingFee: Number(packFee),
          ...(pricingMethod === "overseas" ? { profitPct: Number(profitPct), operationalFee: Number(opFee) } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setSubmitting(false)
    }
  }

  const inputCls = "border border-cream-border rounded-lg px-2 py-1.5 text-sm w-full"
  const labelCls = "text-xs font-medium text-muted"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl p-5 w-full max-w-lg flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-foreground">Price quotation</h3>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Product name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </label>
        {request.estimatedPrice !== null && (
          <div className="rounded-lg border border-cream-border bg-surface-muted px-3 py-2 flex items-center justify-between text-xs">
            <span className="text-muted">
              Customer's own estimate — {countries.find((c) => c.id === request.countryId)?.name ?? "—"} · valas {request.valas} · {request.gram}g
            </span>
            <span className="font-semibold text-foreground tabular-nums">Rp {fmt(request.estimatedPrice)}</span>
          </div>
        )}
        <div className="flex gap-2">
          {(["overseas", "tier_kurs"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setPricingMethod(m)}
              className={`px-3 py-1.5 rounded-lg border text-xs ${
                pricingMethod === m ? "border-brand bg-brand/5 text-brand" : "border-cream-border text-muted"
              }`}
            >
              {m === "overseas" ? "Profit Margin" : "Tier Kurs"}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Country</span>
            <SearchableSelect value={countryId} onChange={setCountryId} options={countryOptions} placeholder="Country…" />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Valas</span>
            <input value={valas} onChange={(e) => setValas(e.target.value)} type="number" step="any" min="0" placeholder="0" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Gram</span>
            <input value={gram} onChange={(e) => setGram(e.target.value)} type="number" min="0" placeholder="0" className={inputCls} />
          </label>
          {pricingMethod === "overseas" ? (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>Profit %</span>
              <input value={profitPct} onChange={(e) => setProfitPct(e.target.value)} type="number" min="0" max="99" placeholder="30" className={inputCls} />
            </label>
          ) : (
            <div className="flex flex-col gap-1">
              <span className={labelCls}>Charged rate</span>
              <div className={`${inputCls} bg-surface-muted text-muted flex items-center tabular-nums`}>
                {previewLoading ? "…" : tieredKursPreview != null ? fmt(tieredKursPreview) : "—"}
              </div>
            </div>
          )}
        </div>
        <div className="grid grid-cols-4 gap-3">
          {pricingMethod === "overseas" && (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>Op Fee</span>
              <input value={opFee} onChange={(e) => setOpFee(e.target.value)} type="number" min="0" placeholder="5000" className={inputCls} />
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Pack Fee</span>
            <input value={packFee} onChange={(e) => setPackFee(e.target.value)} type="number" min="0" placeholder="5000" className={inputCls} />
          </label>
          <div className={`flex flex-col gap-1 ${pricingMethod === "tier_kurs" ? "col-span-2" : ""}`}>
            <span className={labelCls}>Price</span>
            <div className={`${inputCls} bg-surface-muted text-muted flex items-center`}>
              {previewLoading ? "Calculating…" : preview != null ? `Rp ${fmt(preview)}` : "—"}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className={labelCls}>Profit est.</span>
            <div className={`${inputCls} bg-surface-muted text-muted flex items-center`}>
              {previewLoading ? "Calculating…" : profitPreview != null ? `Rp ${fmt(profitPreview)}` : "—"}
            </div>
          </div>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Send to customer"}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Same shape as EditModal (Country/Valas/Gram/Profit%/Op Fee/Pack Fee, live
 * Price + Profit est.), plus the Name field this one actually needs since
 * it creates the real product. Starts from whatever the approved offer
 * already carries (countryId/valas/gram, and 15%/0/0 — the customer's own
 * estimate formula) so the price matches what she was quoted unless the
 * owner deliberately changes something here.
 */
function CreateProductModal({ request, countries, activeEvents, onClose, onDone }: {
  request: CatalogueRequest
  countries: { id: number; name: string; kurs: number; cargoPerKg: number }[]
  activeEvents: string[]
  onClose: () => void
  onDone: () => void
}) {
  const productDefaults = useProductDefaults()
  // Prefers what the owner named/sourced it as during the price quotation
  // (migration 093) over the customer's raw description — falls back to the
  // description only for a row quoted before that field existed.
  const [name, setName] = useState(request.proposedName ?? request.description)
  // Not carried from the quotation step (there's no proposedStore to
  // prefill from) — collected here, right before the product row is made.
  const [store, setStore] = useState("")
  // Approving an offer and then creating the product from it are the same
  // decision made twice — this modal now converts the request onto the new
  // product in the same step, so there's no separate trip through the
  // Convert modal afterward. Same locked-trip convention as DuplicateVariantRow.
  const lockEvent = request.source === "whatsapp" && request.resolvedEvent !== null
  const [event, setEvent] = useState(
    (request.source === "whatsapp" ? request.resolvedEvent : request.defaultEvent) ?? "",
  )
  // A locked-but-inactive event must be in the picker's own option list, or
  // SearchableSelect has no label to show for it and the locked box renders
  // blank even though `event` state is correctly set — same fix ConvertModal
  // already needed for this exact case.
  const eventOptions = useMemo(
    () => (lockEvent && event && !activeEvents.includes(event)) ? [...activeEvents, event] : activeEvents,
    [activeEvents, lockEvent, event],
  )
  // What was actually proposed and approved (migration 089/091) — a row
  // from before that was tracked defaults to 'overseas', same as the
  // column's own DB default.
  const [pricingMethod, setPricingMethod] = useState<"overseas" | "tier_kurs">(request.proposedPricingMethod)
  const [countryId, setCountryId] = useState(request.countryId !== null ? String(request.countryId) : "")
  const [valas, setValas] = useState(request.valas !== null ? String(request.valas) : "")
  const [gram, setGram] = useState(request.gram !== null ? String(request.gram) : "")
  // The exact terms the owner proposed and she approved (migration 089) —
  // not Settings' current customRequest* defaults, which may have changed
  // since. Only a row from before that was tracked (proposedProfitPct null
  // despite being approved) falls back to Settings, filled in below once
  // it loads — same DB-default placeholder pattern as EditModal, so there's
  // no flash of 0/0/0 before that fetch resolves. Only meaningful when
  // pricingMethod is 'overseas'.
  const [profitPct, setProfitPct] = useState(request.proposedProfitPct !== null ? String(request.proposedProfitPct) : "15")
  const [opFee, setOpFee] = useState(request.proposedOperationalFee !== null ? String(request.proposedOperationalFee) : "5000")
  const [packFee, setPackFee] = useState(request.proposedPackingFee !== null ? String(request.proposedPackingFee) : "0")
  const [preview, setPreview] = useState<number | null>(null)
  const [profitPreview, setProfitPreview] = useState<number | null>(null)
  // Only populated under Tier Kurs. Starts from what was actually approved
  // (migration 091), re-resolved live below like every other field here.
  const [tieredKursPreview, setTieredKursPreview] = useState<number | null>(request.proposedTieredKurs)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!productDefaults) return
    if (request.proposedProfitPct === null) setProfitPct(String(productDefaults.customRequestProfitPct))
    if (request.proposedOperationalFee === null) setOpFee(String(productDefaults.customRequestOperationalFee))
    if (request.proposedPackingFee === null) setPackFee(String(productDefaults.customRequestPackingFee))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productDefaults])

  const countryOptions = useMemo(
    () => countries.map((c) => ({ value: String(c.id), label: c.name })),
    [countries],
  )

  useEffect(() => {
    const cId = Number(countryId)
    const v = Number(valas)
    const g = Number(gram)
    const p = Number(profitPct)
    const op = Number(opFee)
    const pack = Number(packFee)
    const overseasFieldsInvalid = pricingMethod === "overseas" && (!(p >= 0) || !(op >= 0))
    if (!cId || !(v > 0) || !(g > 0) || !(pack >= 0) || overseasFieldsInvalid) {
      setPreview(null); setProfitPreview(null); setTieredKursPreview(null)
      return
    }
    const t = setTimeout(async () => {
      setPreviewLoading(true)
      try {
        const qs = new URLSearchParams({ countryId: String(cId), valas: String(v), gram: String(g), packingFee: String(pack), pricingMethod })
        if (pricingMethod === "overseas") {
          qs.set("profitPct", String(p))
          qs.set("operationalFee", String(op))
        }
        const res = await fetch(`/api/sheets/order-requests/preview-price?${qs}`)
        const data = await res.json()
        setPreview(res.ok ? data.estimatedPrice : null)
        setProfitPreview(res.ok ? data.profit : null)
        setTieredKursPreview(res.ok ? data.tieredKurs ?? null : null)
      } catch {
        setPreview(null)
        setProfitPreview(null)
        setTieredKursPreview(null)
      } finally {
        setPreviewLoading(false)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [pricingMethod, countryId, valas, gram, profitPct, opFee, packFee])

  const country = countries.find((c) => c.id === Number(countryId))

  async function submit() {
    if (!name.trim()) { setError("Name is required"); return }
    if (!store.trim()) { setError("Store is required"); return }
    if (!countryId) { setError("Pick a country"); return }
    if (preview === null) { setError("Enter valid pricing inputs"); return }
    if (!event) { setError("Pick an event"); return }
    setSubmitting(true); setError("")
    try {
      const res = await fetch("/api/sheets/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          store: store.trim(),
          pricingMethod,
          countryId: Number(countryId),
          valas: Number(valas),
          gram: Number(gram),
          kurs: country?.kurs ?? 0,
          cargoPerKg: country?.cargoPerKg ?? 0,
          packingFee: Number(packFee),
          // Ignored server-side for tier_kurs (computeProductPrice resolves
          // its own rate) — harmless to still send.
          ...(pricingMethod === "overseas" ? { profitPct: Number(profitPct), operationalFee: Number(opFee) } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")

      const convertRes = await fetch(`/api/sheets/order-requests/${request.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "convert", event, productId: data.id }),
      })
      const convertData = await convertRes.json()
      if (!convertRes.ok) throw new Error(convertData.error ?? "Failed to convert")
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setSubmitting(false)
    }
  }

  const inputCls = "border border-cream-border rounded-lg px-2 py-1.5 text-sm w-full"
  const labelCls = "text-xs font-medium text-muted"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl p-5 w-full max-w-lg flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-foreground">Create product &amp; convert</h3>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Product name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Store</span>
            <input value={store} onChange={(e) => setStore(e.target.value)} placeholder="Where this is sourced from" className={inputCls} />
          </label>
        </div>
        {request.estimatedPrice !== null && (
          <div className="rounded-lg border border-cream-border bg-surface-muted px-3 py-2 flex items-center justify-between text-xs">
            <span className="text-muted">Approved offer</span>
            <span className="font-semibold text-foreground tabular-nums">Rp {fmt(request.estimatedPrice)}</span>
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Event</span>
          <EventSelect value={event} onChange={setEvent} events={eventOptions} placeholder="Select event…" disabled={lockEvent} />
        </label>
        {lockEvent && (
          <p className="text-xs text-faint">Trip terkunci — sudah diketahui dari klaim WhatsApp-nya.</p>
        )}
        <div className="flex gap-2">
          {(["overseas", "tier_kurs"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setPricingMethod(m)}
              className={`px-3 py-1.5 rounded-lg border text-xs ${
                pricingMethod === m ? "border-brand bg-brand/5 text-brand" : "border-cream-border text-muted"
              }`}
            >
              {m === "overseas" ? "Profit Margin" : "Tier Kurs"}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Country</span>
            <SearchableSelect value={countryId} onChange={setCountryId} options={countryOptions} placeholder="Country…" />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Valas</span>
            <input value={valas} onChange={(e) => setValas(e.target.value)} type="number" step="any" min="0" placeholder="0" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Gram</span>
            <input value={gram} onChange={(e) => setGram(e.target.value)} type="number" min="0" placeholder="0" className={inputCls} />
          </label>
          {pricingMethod === "overseas" ? (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>Profit %</span>
              <input value={profitPct} onChange={(e) => setProfitPct(e.target.value)} type="number" min="0" max="99" placeholder="30" className={inputCls} />
            </label>
          ) : (
            <div className="flex flex-col gap-1">
              <span className={labelCls}>Charged rate</span>
              <div className={`${inputCls} bg-surface-muted text-muted flex items-center tabular-nums`}>
                {previewLoading ? "…" : tieredKursPreview != null ? fmt(tieredKursPreview) : "—"}
              </div>
            </div>
          )}
        </div>
        <div className="grid grid-cols-4 gap-3">
          {pricingMethod === "overseas" && (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>Op Fee</span>
              <input value={opFee} onChange={(e) => setOpFee(e.target.value)} type="number" min="0" placeholder="5000" className={inputCls} />
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Pack Fee</span>
            <input value={packFee} onChange={(e) => setPackFee(e.target.value)} type="number" min="0" placeholder="5000" className={inputCls} />
          </label>
          <div className={`flex flex-col gap-1 ${pricingMethod === "tier_kurs" ? "col-span-2" : ""}`}>
            <span className={labelCls}>Price</span>
            <div className={`${inputCls} bg-surface-muted text-muted flex items-center`}>
              {previewLoading ? "Calculating…" : preview != null ? `Rp ${fmt(preview)}` : "—"}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className={labelCls}>Profit est.</span>
            <div className={`${inputCls} bg-surface-muted text-muted flex items-center`}>
              {previewLoading ? "Calculating…" : profitPreview != null ? `Rp ${fmt(profitPreview)}` : "—"}
            </div>
          </div>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Create & convert"}
          </button>
        </div>
      </div>
    </div>
  )
}
