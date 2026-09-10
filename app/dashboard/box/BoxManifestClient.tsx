"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { fetchJson } from "@/lib/api-fetch"
import { fmt } from "@/lib/format"
import EventSelect from "@/components/EventSelect"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { generateCargoDocument, type CargoDocLine } from "@/lib/cargo-document-pdf"
import { generateReceivedReport } from "@/lib/receiving-report-pdf"
import type { ReportCopy, ReportLayout } from "@/lib/receiving-report-groups"
import type { BoxManifest, EventBox, ReceivedReportItem } from "@/lib/db"

/** The receipt field's word for "counted in with no box named on it". */
const UNCODED = "(no box code)"

/** Hand a generated PDF to the browser, then let go of the blob. */
function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  } finally {
    URL.revokeObjectURL(url)
  }
}

type BoxSummary = EventBox

/** The scope the receipt field expresses, and what it will put in a document. */
type Scope =
  | { kind: "trip" }
  | { kind: "prefix"; code: string; boxes: BoxSummary[] }
  | { kind: "box"; code: string }
  | { kind: "uncoded" }

const STATUS_LABEL: Record<BoxSummary["status"], string> = {
  transit: "in transit",
  short: "short",
  opened: "opened",
}
const STATUS_CLASS: Record<BoxSummary["status"], string> = {
  transit: "bg-blue-50 text-blue-700",
  short: "bg-red-50 text-red-700",
  opened: "bg-green-100 text-green-700",
}

/** Today in Asia/Jakarta, so a document is dated by business day. */
function jakartaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date())
}

const INPUT_CLASS =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

function shortDate(iso: string | null): string {
  if (!iso) return ""
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Jakarta",
  }).format(new Date(iso))
}

/**
 * What was in the box, beside who was served out of it.
 *
 * The two used to be the same field, and since arrival started reassigning
 * units to whoever paid first they have drifted apart -- which is fine until a
 * parcel turns up short or the courier disputes it, and the only thing worth
 * having is what was packed.
 *
 * So the difference is the point of this screen, not a footnote on it.
 */
export default function BoxManifestClient() {
  const options = useSheetOptions()
  const [event, setEvent] = useState("")
  const [boxes, setBoxes] = useState<BoxSummary[]>([])
  const [uncoded, setUncoded] = useState(0)
  const [receipt, setReceipt] = useState("")
  const [manifest, setManifest] = useState<BoxManifest | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<"dispatch" | "received" | null>(null)
  const [docError, setDocError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // Per box by default: the box is what this screen is about, and it is the
  // sheet that answers "what came in that parcel".
  const [layout, setLayout] = useState<ReportLayout>("per-box")
  const [copy, setCopy] = useState<ReportCopy>("owner")
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!event) { setBoxes([]); setUncoded(0); return }
    let live = true
    fetchJson<{ boxes: BoxSummary[]; uncoded: number }>(`/api/sheets/dispatch-manifest?event=${encodeURIComponent(event)}`)
      .then((d) => { if (live) { setBoxes(d.boxes ?? []); setUncoded(d.uncoded ?? 0) } })
      .catch(() => { if (live) { setBoxes([]); setUncoded(0) } })
    return () => { live = false }
  }, [event])

  useEffect(() => {
    if (!menuOpen) return
    const h = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false) }
    document.addEventListener("pointerdown", h)
    return () => document.removeEventListener("pointerdown", h)
  }, [menuOpen])

  const open = useCallback(async (code: string) => {
    const trimmed = code.trim()
    if (!trimmed) return
    setLoading(true)
    setError(null)
    setReceipt(trimmed)
    try {
      const d = await fetchJson<{ manifest: BoxManifest }>(
        `/api/sheets/dispatch-manifest?receipt=${encodeURIComponent(trimmed)}`,
      )
      setManifest(d.manifest)
    } catch (err) {
      setManifest(null)
      setError(err instanceof Error ? err.message : "Could not read that box")
    } finally {
      setLoading(false)
    }
  }, [])

  const short = manifest ? manifest.unaccounted : 0

  /**
   * What the field means right now.
   *
   * Empty is the whole trip, a full code is one box, and anything in between
   * is the family it starts -- which is what the field always was, since the
   * document matched on the front of the code. Tapping a card fills it, and
   * trimming the tail widens it.
   */
  const scope: Scope = useMemo(() => {
    const code = receipt.trim()
    if (!code) return { kind: "trip" }
    if (code === UNCODED) return { kind: "uncoded" }
    const exact = boxes.find((b) => b.receipt.toUpperCase() === code.toUpperCase())
    if (exact) return { kind: "box", code: exact.receipt }
    const matched = boxes.filter((b) => b.receipt.toUpperCase().startsWith(code.toUpperCase()))
    return matched.length === 1
      ? { kind: "box", code: matched[0].receipt }
      : { kind: "prefix", code, boxes: matched }
  }, [receipt, boxes])

  /** The boxes a document would cover, and what they add up to. */
  const covered = useMemo(() => {
    if (scope.kind === "uncoded") return [] as BoxSummary[]
    if (scope.kind === "trip") return boxes
    if (scope.kind === "prefix") return scope.boxes
    return boxes.filter((b) => b.receipt.toUpperCase() === scope.code.toUpperCase())
  }, [scope, boxes])

  const coveredUncoded = scope.kind === "trip" || scope.kind === "uncoded" ? uncoded : 0
  const receivedInScope = covered.reduce((n, b) => n + b.received, 0) + coveredUncoded
  const packedInScope = covered.reduce((n, b) => n + b.units, 0)

  /** What the document is called, and what the request asks for. */
  const scopeCode = scope.kind === "box" ? scope.code : scope.kind === "prefix" ? scope.code : ""

  async function downloadDispatch() {
    if (!event) return
    setBusy("dispatch"); setDocError(null)
    try {
      const query = new URLSearchParams({ event })
      if (scopeCode) query.set("receipt", scopeCode)
      const doc = await fetchJson<{ lines: CargoDocLine[] }>(`/api/sheets/dispatch-report?${query}`)
      if (!doc.lines.length) { setDocError("Nothing was packed under that code."); return }
      const title = `${event}${scopeCode ? ` · ${scopeCode}` : ""}`
      const blob = await generateCargoDocument({ name: title, date: jakartaToday(), lines: doc.lines })
      save(blob, `dispatch-${event}${scopeCode ? `-${scopeCode}` : ""}.pdf`)
    } catch (err) {
      setDocError(err instanceof Error ? err.message : "Could not make that document")
    } finally {
      setBusy(null)
    }
  }

  async function downloadReceived() {
    if (!event) return
    setBusy("received"); setDocError(null); setMenuOpen(false)
    try {
      const query = new URLSearchParams({ event })
      if (scopeCode) query.set("receipt", scopeCode)
      // No dates. The scope is the field above, and every arrival this screen
      // can reach is either in a box or in the uncoded group -- both of which
      // the report groups by name rather than by day.
      const report = await fetchJson<{ event: string; items: ReceivedReportItem[] }>(
        `/api/sheets/receiving-report?${query}`)
      const items = scope.kind === "uncoded"
        ? report.items.filter((i) => !i.dispatchReceipt)
        : report.items
      if (!items.length) { setDocError("Nothing has been counted in for that."); return }
      const blob = await generateReceivedReport({
        event: report.event, from: null, to: null, receipt: scopeCode || null,
        items, totalUnits: items.reduce((n, i) => n + i.unitsReceived, 0),
        layout, copy: layout === "per-store" ? copy : "owner",
      })
      const copyPart = layout === "per-store" ? `-${copy}` : ""
      save(blob, `received-${event}${scopeCode ? `-${scopeCode}` : ""}-${layout}${copyPart}.pdf`)
    } catch (err) {
      setDocError(err instanceof Error ? err.message : "Could not make that report")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-xl border border-cream-border bg-white p-4 flex items-end gap-2 sm:gap-3 flex-wrap">
        <div className="w-full sm:w-auto sm:flex-1 min-w-0 sm:min-w-[200px]">
          <EventSelect
            value={event}
            onChange={(v) => { setEvent(v); setManifest(null); setError(null) }}
            events={options?.events ?? []}
            placeholder="Select event…"
          />
        </div>
        {/* Typed straight in, because the receipt on a courier's dispute email
            is the fastest way in and does not need a trip chosen first. */}
        <input
          type="text"
          value={receipt}
          onChange={(e) => setReceipt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") open(receipt) }}
          placeholder="Receipt, e.g. CJI-2607"
          aria-label="Receipt"
          className={`${INPUT_CLASS} h-[38px] flex-1 min-w-0 sm:min-w-[180px]`}
        />
        <button
          type="button"
          onClick={() => open(receipt)}
          disabled={loading || !receipt.trim()}
          className="h-[38px] shrink-0 rounded-lg bg-brand px-4 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50 transition-colors"
        >
          {loading ? "Opening…" : "Open"}
        </button>

        {/* The documents, in the row that already says which boxes we mean.
            They used to live on two other screens behind a receipt field typed
            from memory — which is why the code was looked up on a third. */}
        <button
          type="button"
          onClick={downloadDispatch}
          disabled={!event || busy !== null || packedInScope === 0}
          title={packedInScope === 0 ? "Nothing was packed under this code" : "What was packed and sent"}
          className="h-[38px] shrink-0 rounded-lg bg-brand px-3 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-40 transition-colors"
        >
          {busy === "dispatch" ? "Preparing…" : "⤓ Dispatch"}
        </button>
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            // A box nobody has opened has nothing to report. Offering the
            // button would hand back an empty PDF and a shrug.
            disabled={!event || busy !== null || receivedInScope === 0}
            title={receivedInScope === 0 ? "Nothing has been counted in yet" : "What was counted in"}
            aria-expanded={menuOpen}
            className="h-[38px] rounded-lg border border-cream-border px-3 text-sm text-muted-strong bg-white hover:border-brand hover:text-brand disabled:opacity-40 transition-colors"
          >
            {busy === "received" ? "Preparing…" : "⤓ Received ▾"}
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 w-56 rounded-lg border border-cream-border bg-white shadow-lg p-3 flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">Layout</span>
                <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs">
                  {([["per-box", "Per box"], ["per-store", "Per store"]] as const).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setLayout(v)}
                      className={`flex-1 px-2 py-1.5 transition-colors ${
                        layout === v ? "bg-brand text-white font-medium" : "bg-white text-muted-strong hover:bg-cream"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {/* Only the handed-over sheet has anything to withhold. */}
              {layout === "per-store" && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted">Copy</span>
                  <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs">
                    {([["owner", "Owner"], ["staff", "Staff"]] as const).map(([v, label]) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setCopy(v)}
                        className={`flex-1 px-2 py-1.5 transition-colors ${
                          copy === v ? "bg-brand text-white font-medium" : "bg-white text-muted-strong hover:bg-cream"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={downloadReceived}
                className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-dark transition-colors"
              >
                Make the report
              </button>
            </div>
          )}
        </div>
      </div>

      {docError && (
        <p className="text-sm text-amber-700">{docError}</p>
      )}

      {/* One row, scrolling sideways.
          LSJP202608 has 47 parcels, and wrapped they were seven rows of cards
          standing between the page's own controls and the manifest anybody came
          to read. Newest first, so the box a courier is asking about is usually
          the first thing under the cursor; the receipt field above opens any of
          the others by name. */}
      {boxes.length > 0 && (
        <div className="-mx-1 px-1">
          <div className="flex gap-2 overflow-x-auto pb-2 snap-x">
            {boxes.map((b) => (
              <button
                key={b.receipt}
                type="button"
                onClick={() => (receipt.trim().toUpperCase() === b.receipt.toUpperCase()
                  ? (setReceipt(""), setManifest(null))
                  : open(b.receipt))}
                className={`shrink-0 snap-start rounded-lg border px-3 py-2 text-left transition-colors ${
                  manifest?.receipt.toUpperCase() === b.receipt.toUpperCase()
                    ? "border-brand bg-brand-light"
                    : "border-cream-border bg-white hover:border-brand"
                }`}
              >
                <div className="text-sm font-medium text-foreground tabular-nums whitespace-nowrap flex items-center gap-1.5">
                  {b.receipt}
                  {/* What state the box is in, so what is still out reads off
                      the strip without opening anything. */}
                  <span className={`text-[9px] font-bold uppercase tracking-wide px-1 py-px rounded ${STATUS_CLASS[b.status]}`}>
                    {b.status === "short" ? `${fmt(b.units - b.received)} short` : STATUS_LABEL[b.status]}
                  </span>
                </div>
                <div className="text-[11px] text-muted tabular-nums whitespace-nowrap">
                  {b.status === "transit"
                    ? `${b.units} packed`
                    : `${b.received} of ${b.units} received`}
                  {b.dispatchedAt && ` · ${shortDate(b.dispatchedAt)}`}
                </div>
              </button>
            ))}
            {/* Counted in with no box named. A card of its own, because it is a
                real pile of goods and the only alternative was hiding it. */}
            {uncoded > 0 && (
              <button
                type="button"
                onClick={() => { setReceipt(receipt.trim() === UNCODED ? "" : UNCODED); setManifest(null); setError(null) }}
                className={`shrink-0 snap-start rounded-lg border border-dashed px-3 py-2 text-left transition-colors ${
                  receipt.trim() === UNCODED ? "border-brand bg-brand-light" : "border-cream-border bg-white hover:border-brand"
                }`}
              >
                <div className="text-sm font-medium text-muted-strong whitespace-nowrap">No box code</div>
                <div className="text-[11px] text-muted tabular-nums whitespace-nowrap">{fmt(uncoded)} units received</div>
              </button>
            )}
          </div>
          {/* How many are off to the right, since a scrolling row hides its own
              length — and the count is the cue to use the receipt field instead
              of dragging through forty cards. */}
          <p className="text-[11px] text-faint">
            {boxes.length} {boxes.length === 1 ? "parcel" : "parcels"} on this trip
            {boxes.some((b) => b.status === "transit") && ` · ${boxes.filter((b) => b.status === "transit").length} in transit`}
            {boxes.some((b) => b.status === "short") && ` · ${boxes.filter((b) => b.status === "short").length} short`}
            {" · "}scroll for older, or type a receipt above
          </p>
        </div>
      )}

      {/* More than one box in scope: a row each, opened in place. The question a
          family-wide view is for is "which box is short", and that is a column
          here rather than eleven visits. */}
      {event && !manifest && covered.length > 1 && (
        <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
          <div className="px-5 py-3 border-b border-cream-border flex items-baseline justify-between gap-3 flex-wrap">
            <div className="text-sm font-bold text-foreground">
              {scope.kind === "prefix" ? `${scope.code} · ${covered.length} boxes` : `${event} · ${covered.length} boxes`}
            </div>
            <div className="text-xs text-muted tabular-nums">
              packed {fmt(packedInScope)} · received {fmt(receivedInScope)}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-faint">
                  <th className="text-left font-bold px-5 py-2.5 border-b border-cream-border">Box</th>
                  <th className="text-left font-bold px-5 py-2.5 border-b border-cream-border">Status</th>
                  <th className="text-right font-bold px-5 py-2.5 border-b border-cream-border">Packed</th>
                  <th className="text-right font-bold px-5 py-2.5 border-b border-cream-border">Received</th>
                  <th className="text-right font-bold px-5 py-2.5 border-b border-cream-border">Short</th>
                </tr>
              </thead>
              <tbody>
                {covered.map((b) => {
                  const missing = Math.max(0, b.units - b.received)
                  return (
                    <tr
                      key={b.receipt}
                      onClick={() => open(b.receipt)}
                      className="cursor-pointer hover:bg-surface-muted transition-colors"
                    >
                      <td className="px-5 py-2.5 border-b border-cream-border/60 font-medium text-foreground whitespace-nowrap">{b.receipt}</td>
                      <td className="px-5 py-2.5 border-b border-cream-border/60">
                        <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${STATUS_CLASS[b.status]}`}>
                          {STATUS_LABEL[b.status]}
                        </span>
                      </td>
                      <td className="px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums">{fmt(b.units)}</td>
                      <td className="px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums">{fmt(b.received)}</td>
                      <td className={`px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums font-semibold ${
                        missing === 0 ? "text-faint" : "text-red-700"
                      }`}>
                        {missing === 0 ? "—" : fmt(missing)}
                      </td>
                    </tr>
                  )
                })}
                {coveredUncoded > 0 && (
                  <tr onClick={() => setReceipt(UNCODED)} className="cursor-pointer hover:bg-surface-muted transition-colors">
                    <td className="px-5 py-2.5 border-b border-cream-border/60 text-muted-strong italic">No box code</td>
                    <td className="px-5 py-2.5 border-b border-cream-border/60" />
                    <td className="px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums text-faint">—</td>
                    <td className="px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums">{fmt(coveredUncoded)}</td>
                    <td className="px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums text-faint">—</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="px-5 py-2.5 border-t border-cream-border text-xs text-muted">
            Tap a box for what is inside it. The documents above cover every box listed here.
          </p>
        </div>
      )}

      {event && boxes.length === 0 && (
        <p className="text-sm text-muted">
          No box was recorded for this trip. Most trips before September 2026 were dispatched
          without a tracking number, and nothing can be reconstructed for those.
        </p>
      )}

      {error && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{error}</div>
      )}

      {manifest && (
        <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
          <div className="px-5 py-4 border-b border-cream-border flex items-baseline justify-between gap-4 flex-wrap">
            <div>
              <div className="text-lg font-bold text-foreground">{manifest.receipt}</div>
              {/* A box carrying more than one trip is named by the count, not by
                  whichever of them sorted first. MU-19953 holds three, and this
                  line used to pick one and print it over all of them. */}
              <div className="text-xs text-muted" title={manifest.trips.map((t) => `${t.event} · ${t.packed}`).join("\n")}>
                {manifest.trips.length > 1 ? `${manifest.trips.length} trips` : manifest.event}
                {manifest.dispatchedAt && ` · dispatched ${shortDate(manifest.dispatchedAt)}`}
              </div>
            </div>
            <div className="text-sm text-muted tabular-nums">
              packed {fmt(manifest.packedTotal)} · assigned {fmt(manifest.assignedTotal)} · received {fmt(manifest.receivedTotal)}
              {manifest.surplusTotal > 0 && ` · ${fmt(manifest.surplusTotal)} surplus`}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-faint">
                  {/* Only on a box that carries more than one — on the other
                      sixty it would be the same word repeated down the page. */}
                  {manifest.trips.length > 1 && (
                    <th className="text-left font-bold px-5 py-2.5 border-b border-cream-border">Trip</th>
                  )}
                  <th className="text-left font-bold px-5 py-2.5 border-b border-cream-border">Product</th>
                  <th className="text-right font-bold px-5 py-2.5 border-b border-cream-border">Packed</th>
                  <th className="text-right font-bold px-5 py-2.5 border-b border-cream-border">Surplus</th>
                  <th className="text-right font-bold px-5 py-2.5 border-b border-cream-border">Assigned</th>
                  <th className="text-right font-bold px-5 py-2.5 border-b border-cream-border">Received</th>
                  <th className="text-right font-bold px-5 py-2.5 border-b border-cream-border">Difference</th>
                </tr>
              </thead>
              <tbody>
                {manifest.lines.map((l) => {
                  // Surplus belongs to nobody, so it can never be "served" — counting
                  // it as missing would cry wolf on every box carrying overbuy.
                  const diff = l.packed - l.surplus - l.received
                  return (
                    <tr key={`${l.event}|${l.productId}`} className={diff !== 0 ? "bg-amber-50/60" : ""}>
                      {manifest.trips.length > 1 && (
                        <td className={`px-5 py-2.5 border-b border-cream-border/60 whitespace-nowrap ${
                          l.event === event ? "font-bold text-foreground" : "text-muted"
                        }`}>
                          {l.event}
                        </td>
                      )}
                      <td className="px-5 py-2.5 border-b border-cream-border/60 text-foreground">{l.productName}</td>
                      <td className="px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums">{fmt(l.packed)}</td>
                      <td className={`px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums ${l.surplus > 0 ? "text-muted-strong" : "text-faint"}`}>
                        {l.surplus > 0 ? fmt(l.surplus) : "—"}
                      </td>
                      <td className="px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums text-muted">{fmt(l.assigned)}</td>
                      <td className="px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums">{fmt(l.received)}</td>
                      <td className={`px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums font-semibold ${
                        diff === 0 ? "text-faint" : "text-amber-700"
                      }`}>
                        {diff === 0 ? "—" : diff > 0 ? `−${fmt(diff)}` : `+${fmt(-diff)}`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="font-bold">
                  {manifest.trips.length > 1 && <td className="px-5 py-3" />}
                  <td className="px-5 py-3">Total</td>
                  <td className="px-5 py-3 text-right tabular-nums">{fmt(manifest.packedTotal)}</td>
                  <td className={`px-5 py-3 text-right tabular-nums ${manifest.surplusTotal > 0 ? "" : "text-faint"}`}>
                    {manifest.surplusTotal > 0 ? fmt(manifest.surplusTotal) : "—"}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-muted">{fmt(manifest.assignedTotal)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{fmt(manifest.receivedTotal)}</td>
                  <td className={`px-5 py-3 text-right tabular-nums ${short === 0 ? "text-faint" : "text-amber-700"}`}>
                    {short === 0 ? "—" : short > 0 ? `−${fmt(short)}` : `+${fmt(-short)}`}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* The difference is never self-explanatory: it is either a short box
              or a unit reassigned at arrival, and only a person can tell which. */}
          <div className="px-5 py-3 border-t border-cream-border text-xs text-muted">
            {short === 0 ? (
              <>
                Everything packed in this box was served out of it
                {manifest.surplusTotal > 0 && `, besides ${fmt(manifest.surplusTotal)} surplus nobody had ordered`}.
              </>
            ) : short > 0 ? (
              <>
                <b className="text-foreground">{fmt(short)} short.</b> Either the box arrived
                light, or those units were reassigned at receiving to serve someone who had paid
                first — the manifest cannot say which, only that it happened.
              </>
            ) : (
              <>
                <b className="text-foreground">{fmt(-short)} more served than packed.</b> Units from
                another box were used to fill orders now reading this receipt.
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
