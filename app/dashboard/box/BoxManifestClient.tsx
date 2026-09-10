"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  over: "over",
  opened: "opened",
}
const STATUS_CLASS: Record<BoxSummary["status"], string> = {
  transit: "bg-blue-50 text-blue-700",
  short: "bg-red-50 text-red-700",
  over: "bg-amber-50 text-amber-700",
  opened: "bg-green-100 text-green-700",
}

/**
 * What the badge says, in the same signed language as the tables.
 *
 * A box that came up light and a box that took in more than it held are the
 * same measurement with opposite signs, so they read the same way here: −3 and
 * +1, not "3 short" beside a word that cannot describe the other case.
 */
function statusBadge(b: BoxSummary): string {
  const diff = b.units - b.received
  if (b.status === "short") return `−${fmt(diff)}`
  if (b.status === "over") return `+${fmt(-diff)}`
  return STATUS_LABEL[b.status]
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
  const [uncodedPacked, setUncodedPacked] = useState(0)
  const [receipt, setReceipt] = useState("")
  const [manifest, setManifest] = useState<BoxManifest | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * The row opened inside the list, and the boxes already fetched for it.
   *
   * Expanding beats jumping: what a family view is for is "which box is
   * short", and the follow-up is "short of what" -- which should not cost
   * the list you were reading.
   */
  const [expanded, setExpanded] = useState<string | null>(null)
  const [opened, setOpened] = useState<Record<string, BoxManifest>>({})
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
    fetchJson<{ boxes: BoxSummary[]; uncoded: number; uncodedPacked: number }>(
      `/api/sheets/dispatch-manifest?event=${encodeURIComponent(event)}`)
      .then((d) => {
        if (!live) return
        setBoxes(d.boxes ?? []); setUncoded(d.uncoded ?? 0); setUncodedPacked(d.uncodedPacked ?? 0)
      })
      .catch(() => { if (live) { setBoxes([]); setUncoded(0); setUncodedPacked(0) } })
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
    if (!trimmed || trimmed === UNCODED) return
    // A prefix is not a box: "CJI" is twenty-three of them, and asking the
    // server for a box by that name gets a 404 for something that is not
    // missing. The list below is already showing them, so opening does
    // nothing until the code names one box.
    const named = boxes.filter((b) => b.receipt.toUpperCase().startsWith(trimmed.toUpperCase()))
    if (named.length > 1) { setManifest(null); setError(null); return }
    setLoading(true)
    setError(null)
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
  }, [boxes])


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
    // A box that is open IS the scope, whether or not this trip lists it. Read
    // off the strip alone, a box looked up by name with no trip chosen was a
    // prefix matching nothing -- so the effect below closed it the instant the
    // lookup returned it.
    if (manifest && manifest.receipt.toUpperCase() === code.toUpperCase()) {
      return { kind: "box", code: manifest.receipt }
    }
    const exact = boxes.find((b) => b.receipt.toUpperCase() === code.toUpperCase())
    if (exact) return { kind: "box", code: exact.receipt }
    const matched = boxes.filter((b) => b.receipt.toUpperCase().startsWith(code.toUpperCase()))
    return matched.length === 1
      ? { kind: "box", code: matched[0].receipt }
      : { kind: "prefix", code, boxes: matched }
  }, [receipt, boxes, manifest])

  /**
   * True while the field names a family rather than one box.
   *
   * Zero matches is NOT many: a code this trip has never heard of is still a
   * box somewhere, and the field has always been the way in from a courier's
   * email. Treating it as a family disabled Open and left the page blank.
   */
  const scopeIsMany = scope.kind === "prefix" && scope.boxes.length > 1

  /**
   * An open box closes when the field stops naming it.
   *
   * Trimming "CJI-14" to "CJI" widens the scope to the family, and the
   * documents follow immediately -- but the manifest below went on showing the
   * one box, so the screen said "CJI-14" while the buttons meant twenty-three.
   */
  useEffect(() => {
    if (!manifest) return
    // Keyed on what the field MEANS, not on its exact letters. "CJI-4450"
    // still names CJI-44508 and nothing else, so backspacing one character
    // must not close the box — and closing it made the effect above reopen it,
    // which typed the full code back into the field under her hands.
    const stillThisBox = scope.kind === "box" && scope.code.toUpperCase() === manifest.receipt.toUpperCase()
    if (!stillThisBox) {
      setManifest(null)
      setError(null)
    }
  }, [scope, manifest])

  /**
   * A code that names one box opens it, without pressing anything.
   *
   * Typing a full receipt left the page blank: the scope knew it was a box,
   * the buttons were armed for it, and the manifest below waited for a button
   * nobody should have to find. Tapping a card had always opened one, so the
   * field was the odd one out.
   *
   * Held for a moment so it does not fetch a box for every keystroke on the
   * way to the one being typed.
   */
  useEffect(() => {
    if (scope.kind !== "box") return
    if (manifest && manifest.receipt.toUpperCase() === scope.code.toUpperCase()) return
    const t = setTimeout(() => { void open(scope.code) }, 250)
    return () => clearTimeout(t)
  }, [scope, manifest, open])


  /** Open one box's lines inside the list, fetching it the first time. */
  const toggleRow = useCallback(async (code: string) => {
    setExpanded((cur) => (cur === code ? null : code))
    if (opened[code]) return
    try {
      const d = await fetchJson<{ manifest: BoxManifest }>(
        `/api/sheets/dispatch-manifest?receipt=${encodeURIComponent(code)}`)
      setOpened((prev) => ({ ...prev, [code]: d.manifest }))
    } catch {
      // The row closes again rather than sitting open over nothing; its own
      // numbers are on the row itself either way.
      setExpanded((cur) => (cur === code ? null : cur))
    }
  }, [opened])

  /** The boxes a document would cover, and what they add up to. */
  const covered = useMemo(() => {
    if (scope.kind === "uncoded") return [] as BoxSummary[]
    if (scope.kind === "trip") return boxes
    if (scope.kind === "prefix") return scope.boxes
    return boxes.filter((b) => b.receipt.toUpperCase() === scope.code.toUpperCase())
  }, [scope, boxes])

  const coveredUncoded = scope.kind === "trip" || scope.kind === "uncoded" ? uncoded : 0
  // A box opened by name may belong to a trip the strip is not showing, and
  // then `covered` is empty -- the documents took their totals from the strip
  // and refused to run for a box plainly on screen.
  const loose = scope.kind === "box" && covered.length === 0 && manifest ? manifest : null
  const receivedInScope = covered.reduce((n, b) => n + b.received, 0) + coveredUncoded
    + (loose?.receivedTotal ?? 0)
  // The unnamed lines are packed goods like any other, so the group can make a
  // dispatch document. Counting only named boxes left the card able to produce
  // one document out of two.
  const packedInScope = covered.reduce((n, b) => n + b.units, 0)
    + (scope.kind === "trip" || scope.kind === "uncoded" ? uncodedPacked : 0)
    + (loose?.packedTotal ?? 0)

  /** What the document is called, and what the request asks for. */
  const scopeCode = scope.kind === "uncoded"
    ? UNCODED
    : scope.kind === "box" || scope.kind === "prefix" ? scope.code : ""

  async function downloadDispatch() {
    if (!event && scope.kind !== "box") return
    setBusy("dispatch"); setDocError(null)
    try {
      const query = new URLSearchParams()
      // A box's document is the box's, across every trip its goods came from.
      // A trip, a family or the uncoded group are all scoped to the trip.
      if (scope.kind !== "box" && event) query.set("event", event)
      if (scopeCode) query.set("receipt", scopeCode)
      const doc = await fetchJson<{ lines: CargoDocLine[] }>(`/api/sheets/dispatch-report?${query}`)
      if (!doc.lines.length) { setDocError("Nothing was packed under that code."); return }
      const title = scope.kind === "box"
        ? `${scopeCode}${manifest && manifest.trips.length > 1 ? ` · ${manifest.trips.length} trips` : manifest ? ` · ${manifest.event}` : ""}`
        : `${event}${scopeCode ? ` · ${scopeCode}` : ""}`
      const blob = await generateCargoDocument({ name: title, date: jakartaToday(), lines: doc.lines })
      const name = scope.kind === "uncoded" ? "no-box-code" : scopeCode
      save(blob, scope.kind === "box"
        ? `dispatch-${name}.pdf`
        : `dispatch-${event}${name ? `-${name}` : ""}.pdf`)
    } catch (err) {
      setDocError(err instanceof Error ? err.message : "Could not make that document")
    } finally {
      setBusy(null)
    }
  }

  async function downloadReceived() {
    // The received report is still per trip: it groups by store as well as by
    // box, and a store's total across two trips is not a sheet anybody hands
    // over. A box opened by name uses the trip it belongs to.
    if (!event && !manifest) return
    setBusy("received"); setDocError(null); setMenuOpen(false)
    try {
      const query = new URLSearchParams()
      query.set("event", event || manifest!.event)
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
      const namePart = scope.kind === "uncoded" ? "no-box-code" : scopeCode
      save(blob, `received-${event}${namePart ? `-${namePart}` : ""}-${layout}${copyPart}.pdf`)
    } catch (err) {
      setDocError(err instanceof Error ? err.message : "Could not make that report")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Centred, not bottom-aligned: every control in this row is the same
          height now, and "end" only mattered when one of them carried a label
          above it. */}
      <div className="rounded-xl border border-cream-border bg-white p-4 flex items-center gap-2 sm:gap-3 flex-wrap">
        <div className="w-full sm:w-auto sm:flex-1 min-w-0 sm:min-w-[220px]">
          {/* The trip still means "whose boxes am I browsing" -- the strip below
              is this trip's. When the open box reaches past it, the other trips
              are named inside the field in a lighter ink: selected first, the
              rest after it. A line underneath said the same thing and pushed
              the row out of line with the buttons beside it. */}
          <EventSelect
            value={event}
            onChange={(v) => { setEvent(v); setManifest(null); setError(null) }}
            events={options?.events ?? []}
            placeholder="Select event…"
            // Only alongside a chosen trip: with none chosen there is nothing
            // for the other trips to be "other" than, and the box's own header
            // already says how many it carries.
            suffix={event && manifest && manifest.trips.length > 1
              ? `, ${manifest.trips.map((t) => t.event).filter((e) => e !== event).join(", ")}`
              : undefined}
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
          className={`${INPUT_CLASS} h-10 flex-1 min-w-0 sm:min-w-[180px]`}
        />
        <button
          type="button"
          onClick={() => open(receipt)}
          disabled={loading || !receipt.trim() || receipt.trim() === UNCODED || scopeIsMany}
          className="h-10 shrink-0 rounded-lg bg-brand px-4 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50 transition-colors"
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
          // Same weight as Received: they are two halves of one job, and a
          // filled button beside an outlined one says one of them is the thing
          // to press. Open stays filled — it is the page's own action.
          className="h-10 shrink-0 rounded-lg border border-cream-border px-3 text-sm text-muted-strong bg-white hover:border-brand hover:text-brand disabled:opacity-40 transition-colors"
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
            className="h-10 rounded-lg border border-cream-border px-3 text-sm text-muted-strong bg-white hover:border-brand hover:text-brand disabled:opacity-40 transition-colors"
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
                onClick={() => setReceipt(
                  receipt.trim().toUpperCase() === b.receipt.toUpperCase() ? "" : b.receipt,
                )}
                // Selected is the maroon border and nothing else. Hover keeps
                // its own mark — a shadow rather than a border — so pointing at
                // a card and having chosen one do not look the same.
                className={`shrink-0 snap-start rounded-lg border px-3 py-2 text-left bg-white transition-all ${
                  manifest?.receipt.toUpperCase() === b.receipt.toUpperCase()
                    ? "border-brand"
                    : "border-cream-border hover:shadow-[0_1px_6px_rgba(34,31,28,0.12)]"
                }`}
              >
                <div className="text-sm font-medium text-foreground tabular-nums whitespace-nowrap flex items-center gap-1.5">
                  {b.receipt}
                  {/* What state the box is in, so what is still out reads off
                      the strip without opening anything. */}
                  <span className={`text-[9px] font-bold uppercase tracking-wide px-1 py-px rounded ${STATUS_CLASS[b.status]}`}>
                    {statusBadge(b)}
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
                className={`shrink-0 snap-start rounded-lg border border-dashed px-3 py-2 text-left bg-white transition-all ${
                  receipt.trim() === UNCODED
                    ? "border-brand"
                    : "border-cream-border hover:shadow-[0_1px_6px_rgba(34,31,28,0.12)]"
                }`}
              >
                <div className="text-sm font-medium text-muted-strong whitespace-nowrap">No box code</div>
                <div className="text-[11px] text-muted tabular-nums whitespace-nowrap">
                  {uncodedPacked > 0 ? `${fmt(uncodedPacked)} packed · ` : ""}{fmt(uncoded)} received
                </div>
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
            {boxes.some((b) => b.status === "over") && ` · ${boxes.filter((b) => b.status === "over").length} over`}
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
            {/* Fixed layout: with the widths free, opening a row let the long
                product names decide column one, and every column after it slid
                right — the status badge moved on expand and moved back on
                collapse. The widths are the header's now, whatever is below. */}
            <table className="w-full text-sm table-fixed min-w-[560px]">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-faint">
                  <th className="text-left font-bold px-5 py-2.5 border-b border-cream-border w-[40%]">Box</th>
                  {/* Two things live in this column: the box's state on its own
                      row, and — on a box carrying more than one trip — which
                      trip each product belongs to. */}
                  <th className="text-left font-bold px-5 py-2.5 border-b border-cream-border w-[16%]">Status · Trip</th>
                  <th className="text-right font-bold px-5 py-2.5 border-b border-cream-border w-[14%]">Packed</th>
                  <th className="text-right font-bold px-5 py-2.5 border-b border-cream-border w-[15%]">Received</th>
                  <th className="text-right font-bold px-5 py-2.5 border-b border-cream-border w-[15%]">Difference</th>
                </tr>
              </thead>
              <tbody>
                {covered.map((b) => {
                  // Signed, not floored at zero: a box can hand back more than
                  // it was packed with, when units from elsewhere were counted
                  // into it. Calling that "short 0" hid it.
                  const diff = b.units - b.received
                  return (
                    <React.Fragment key={b.receipt}>
                    <tr
                      onClick={() => toggleRow(b.receipt)}
                      className={`cursor-pointer transition-colors ${
                        expanded === b.receipt ? "bg-cream" : "hover:bg-surface-muted"
                      }`}
                    >
                      <td className="px-5 py-2.5 border-b border-cream-border/60 font-medium text-foreground whitespace-nowrap">
                        {/* Fixed width, so the product names below start at the
                            same x as the box code above them. */}
                        <span className="inline-block w-4 text-faint">{expanded === b.receipt ? "▾" : "▸"}</span>
                        {b.receipt}
                      </td>
                      <td className="px-5 py-2.5 border-b border-cream-border/60">
                        <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${STATUS_CLASS[b.status]}`}>
                          {statusBadge(b)}
                        </span>
                      </td>
                      <td className="px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums">{fmt(b.units)}</td>
                      <td className="px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums">{fmt(b.received)}</td>
                      <td className={`px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums font-semibold ${
                        diff === 0 ? "text-faint" : diff > 0 ? "text-red-700" : "text-amber-700"
                      }`}>
                        {diff === 0 ? "—" : diff > 0 ? `−${fmt(diff)}` : `+${fmt(-diff)}`}
                      </td>
                    </tr>
                    {expanded === b.receipt && (opened[b.receipt]
                      ? opened[b.receipt].lines.map((l) => {
                          const lineDiff = l.packed - l.surplus - l.received
                          return (
                            <tr key={`${b.receipt}|${l.event}|${l.productId}`} className="bg-surface-muted/60 text-xs">
                              {/* pl-9 = the row above's px-5 plus its caret, so a
                                  product starts where its box code starts. */}
                              <td
                                className="pl-9 pr-5 py-1.5 border-b border-cream-border/60 text-muted-strong truncate"
                                title={l.productName}
                              >
                                {l.productName}
                              </td>
                              {/* In the second column, under the badge that names
                                  the box's state — a column of its own, lined up,
                                  now that the widths no longer move when a row
                                  opens. Only a box carrying more than one trip
                                  has anything to put here. */}
                              <td className="px-5 py-1.5 border-b border-cream-border/60 text-faint truncate">
                                {opened[b.receipt].trips.length > 1 ? l.event : ""}
                              </td>
                              <td className="px-5 py-1.5 border-b border-cream-border/60 text-right tabular-nums text-muted">{fmt(l.packed)}</td>
                              <td className="px-5 py-1.5 border-b border-cream-border/60 text-right tabular-nums text-muted">{fmt(l.received)}</td>
                              <td className={`px-5 py-1.5 border-b border-cream-border/60 text-right tabular-nums ${
                                lineDiff === 0 ? "text-faint" : lineDiff > 0 ? "text-red-700 font-semibold" : "text-amber-700 font-semibold"
                              }`}>
                                {lineDiff === 0 ? "—" : lineDiff > 0 ? `−${fmt(lineDiff)}` : `+${fmt(-lineDiff)}`}
                              </td>
                            </tr>
                          )
                        })
                      : (
                        <tr className="bg-surface-muted/60 text-xs">
                          <td colSpan={5} className="px-5 py-2 border-b border-cream-border/60 text-faint">Opening…</td>
                        </tr>
                      ))}
                    </React.Fragment>
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
            Tap a box to see what is inside it, without leaving the list. The documents above
            cover every box listed here.
          </p>
        </div>
      )}

      {/* A code that matches nothing on this trip. It may still be a real box —
          another trip's, or one this trip never packed — so the way in is
          offered rather than the screen just going quiet. */}
      {scope.kind === "prefix" && scope.boxes.length === 0 && !manifest && !loading && !error && (
        <p className="text-sm text-muted">
          {event ? (
            <>
              No box on {event} starts with <b className="text-foreground">{receipt.trim()}</b>. Press{" "}
              <b className="text-foreground">Open</b> to look it up anyway — a box from another trip
              opens by name.
            </>
          ) : (
            <>
              {/* A receipt is enough on its own: it is what a courier's email
                  carries, and no trip has to be guessed first. */}
              No trip chosen. Press <b className="text-foreground">Open</b> to look up{" "}
              <b className="text-foreground">{receipt.trim()}</b> by name.
            </>
          )}
        </p>
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
                  // Surplus belongs to nobody, so it can never come back — counting
                  // it as missing would cry wolf on every box carrying overbuy.
                  const diff = l.packed - l.surplus - l.received
                  /**
                   * A faint neutral tint, and nothing else.
                   *
                   * The red-or-amber rule beside it was the Difference column's
                   * own colour said twice. The tint is not saying which way the
                   * line went -- only that this is a row to read, which is what
                   * lets a long manifest be skimmed.
                   *
                   * Only once the box has been opened: a box still at sea has
                   * every line unreceived, and tinting all of them shouts about
                   * a parcel that has simply not arrived.
                   */
                  const flag = manifest.receivedTotal > 0 && diff !== 0
                  return (
                    <tr key={`${l.event}|${l.productId}`} className={flag ? "bg-surface-muted/70" : ""}>
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
                  {/* Same colours as the lines above it: red for a box that
                      came up light, amber for one that took in more than it
                      held. It was amber either way, which made a shortfall and
                      a surplus look like the same event. */}
                  <td className={`px-5 py-3 text-right tabular-nums ${
                    short === 0 ? "text-faint" : short > 0 ? "text-red-700" : "text-amber-700"
                  }`}>
                    {short === 0 ? "—" : short > 0 ? `−${fmt(short)}` : `+${fmt(-short)}`}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

        </div>
      )}
    </div>
  )
}
