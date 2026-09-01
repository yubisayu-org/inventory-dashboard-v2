"use client"

import { useCallback, useEffect, useState } from "react"
import { fetchJson } from "@/lib/api-fetch"
import { fmt } from "@/lib/format"
import EventSelect from "@/components/EventSelect"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import type { BoxManifest } from "@/lib/db"

type BoxSummary = { receipt: string; lines: number; units: number; dispatchedAt: string | null }

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
  const [receipt, setReceipt] = useState("")
  const [manifest, setManifest] = useState<BoxManifest | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!event) { setBoxes([]); return }
    let live = true
    fetchJson<{ boxes: BoxSummary[] }>(`/api/sheets/dispatch-manifest?event=${encodeURIComponent(event)}`)
      .then((d) => { if (live) setBoxes(d.boxes ?? []) })
      .catch(() => { if (live) setBoxes([]) })
    return () => { live = false }
  }, [event])

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
      </div>

      {boxes.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {boxes.map((b) => (
            <button
              key={b.receipt}
              type="button"
              onClick={() => open(b.receipt)}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                manifest?.receipt.toUpperCase() === b.receipt.toUpperCase()
                  ? "border-brand bg-brand-light"
                  : "border-cream-border bg-white hover:border-brand"
              }`}
            >
              <div className="text-sm font-medium text-foreground tabular-nums">{b.receipt}</div>
              <div className="text-[11px] text-muted tabular-nums">
                {b.units} units · {b.lines} {b.lines === 1 ? "line" : "lines"}
                {b.dispatchedAt && ` · ${shortDate(b.dispatchedAt)}`}
              </div>
            </button>
          ))}
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
              <div className="text-xs text-muted">
                {manifest.event}
                {manifest.dispatchedAt && ` · dispatched ${shortDate(manifest.dispatchedAt)}`}
              </div>
            </div>
            <div className="text-sm text-muted tabular-nums">
              packed {fmt(manifest.packedTotal)} · served {fmt(manifest.servedTotal)}
              {manifest.surplusTotal > 0 && ` · ${fmt(manifest.surplusTotal)} surplus`}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-faint">
                  <th className="text-left font-bold px-5 py-2.5 border-b border-cream-border">Product</th>
                  <th className="text-right font-bold px-5 py-2.5 border-b border-cream-border">Packed</th>
                  <th className="text-right font-bold px-5 py-2.5 border-b border-cream-border">Surplus</th>
                  <th className="text-right font-bold px-5 py-2.5 border-b border-cream-border">Served</th>
                  <th className="text-right font-bold px-5 py-2.5 border-b border-cream-border">Difference</th>
                </tr>
              </thead>
              <tbody>
                {manifest.lines.map((l) => {
                  // Surplus belongs to nobody, so it can never be "served" — counting
                  // it as missing would cry wolf on every box carrying overbuy.
                  const diff = l.packed - l.surplus - l.served
                  return (
                    <tr key={l.productId} className={diff !== 0 ? "bg-amber-50/60" : ""}>
                      <td className="px-5 py-2.5 border-b border-cream-border/60 text-foreground">{l.productName}</td>
                      <td className="px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums">{fmt(l.packed)}</td>
                      <td className={`px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums ${l.surplus > 0 ? "text-muted-strong" : "text-faint"}`}>
                        {l.surplus > 0 ? fmt(l.surplus) : "—"}
                      </td>
                      <td className="px-5 py-2.5 border-b border-cream-border/60 text-right tabular-nums">{fmt(l.served)}</td>
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
                  <td className="px-5 py-3">Total</td>
                  <td className="px-5 py-3 text-right tabular-nums">{fmt(manifest.packedTotal)}</td>
                  <td className={`px-5 py-3 text-right tabular-nums ${manifest.surplusTotal > 0 ? "" : "text-faint"}`}>
                    {manifest.surplusTotal > 0 ? fmt(manifest.surplusTotal) : "—"}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">{fmt(manifest.servedTotal)}</td>
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
