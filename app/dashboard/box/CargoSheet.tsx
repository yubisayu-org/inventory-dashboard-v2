"use client"

import React, { useCallback, useEffect, useState } from "react"
import { fetchJson } from "@/lib/api-fetch"
import { fmt } from "@/lib/format"
import type { CargoSummary } from "@/lib/db"

const RP = (n: number) => `Rp ${fmt(n)}`

function shortDate(iso: string | null): string {
  if (!iso) return ""
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", timeZone: "Asia/Jakarta",
  }).format(new Date(`${iso}T00:00:00+07:00`))
}

/**
 * One delivery, on top of the manifest that sent for it.
 *
 * It owns a single number -- the weight -- and reads everything else from
 * whoever already owns it: the boxes from the arrivals that named it, the
 * dates from when those were counted, the cost from the expense rows tagged to
 * it. That is why there is no money to edit here. A bill is attached on the
 * Operational Expenses page, where every other rupiah is corrected, so there
 * is one place to fix a number and never two figures to reconcile.
 */
export default function CargoSheet({ receipt, event, onClose, onPickBox }: {
  receipt: string
  event: string
  onClose: () => void
  onPickBox: (code: string) => void
}) {
  const [cargo, setCargo] = useState<CargoSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [weight, setWeight] = useState("")
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const d = await fetchJson<{ cargo: CargoSummary }>(
        `/api/sheets/cargo?receipt=${encodeURIComponent(receipt)}`)
      setCargo(d.cargo)
      setWeight(d.cargo.weightKg === null ? "" : String(d.cargo.weightKg))
    } catch (err) {
      setCargo(null)
      setError(err instanceof Error ? err.message : "Could not read that delivery")
    }
  }, [receipt])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", h)
    return () => document.removeEventListener("keydown", h)
  }, [onClose])

  async function saveWeight() {
    setSaving(true)
    try {
      await fetchJson("/api/sheets/cargo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receipt, weightKg: weight.trim() === "" ? null : Number(weight) }),
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the weight")
    } finally {
      setSaving(false)
    }
  }

  const cost = cargo?.cost ?? 0
  const kilos = cargo?.weightKg ?? 0
  const perKg = cost && kilos ? Math.round(cost / kilos) : null
  const perBox = cost && cargo?.boxes.length ? Math.round(cost / cargo.boxes.length) : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 sm:p-8"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-xl rounded-xl border border-cream-border bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-cream-border">
          <div>
            <h3 className="text-base font-bold text-foreground">Cargo {cargo?.receipt ?? receipt}</h3>
            <p className="text-xs text-muted tabular-nums">
              {cargo
                ? [
                    `${cargo.boxes.length} ${cargo.boxes.length === 1 ? "box" : "boxes"}`,
                    `${fmt(cargo.received)} units received`,
                    cargo.firstReceived === cargo.lastReceived
                      ? shortDate(cargo.firstReceived)
                      : `${shortDate(cargo.firstReceived)} – ${shortDate(cargo.lastReceived)}`,
                  ].filter(Boolean).join(" · ")
                : "Reading…"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg border border-cream-border px-3 py-1.5 text-sm text-muted-strong hover:border-brand hover:text-brand transition-colors"
          >
            Close
          </button>
        </div>

        {error && <p className="px-5 py-3 text-sm text-amber-700">{error}</p>}

        {cargo && (
          <div className="flex flex-col gap-4 p-5">
            {/* What it cost, and what that works out at. Per kg is the figure
                worth arguing with the freight company about; per box is the
                one that lands in a customer's ongkir. */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px rounded-lg overflow-hidden bg-cream-border">
              {([
                ["Cost", cost ? RP(cost) : "—"],
                ["Weight", cargo.weightKg === null ? "—" : `${fmt(cargo.weightKg)} kg`],
                ["Per kg", perKg ? RP(perKg) : "—"],
                ["Per box", perBox ? RP(perBox) : "—"],
              ] as const).map(([k, v]) => (
                <div key={k} className="bg-white px-3 py-2">
                  <div className="text-[11px] text-muted">{k}</div>
                  <div className="text-sm font-bold text-foreground tabular-nums">{v}</div>
                </div>
              ))}
            </div>

            <div>
              <div className="text-xs font-medium text-muted mb-1">
                Boxes {cargo.events.length > 1 && `· ${cargo.events.join(", ")}`}
              </div>
              <div className="rounded-lg border border-cream-border overflow-hidden">
                {cargo.boxes.map((b) => (
                  <button
                    key={b.receipt}
                    type="button"
                    onClick={() => { onPickBox(b.receipt); onClose() }}
                    className="w-full flex items-baseline justify-between gap-3 px-3 py-2 text-left border-b border-cream-border last:border-b-0 hover:bg-cream transition-colors"
                  >
                    <span className="text-sm font-medium text-foreground">{b.receipt}</span>
                    <span className="text-xs text-muted tabular-nums">
                      {b.event !== event && `${b.event} · `}
                      received {fmt(b.received)}{b.packed > 0 && ` of ${fmt(b.packed)}`}
                    </span>
                  </button>
                ))}
                {cargo.looseUnits > 0 && (
                  <div className="flex items-baseline justify-between gap-3 px-3 py-2 border-t border-cream-border">
                    <span className="text-sm text-muted-strong">No box code</span>
                    <span className="text-xs text-muted tabular-nums">{fmt(cargo.looseUnits)} units</span>
                  </div>
                )}
                {cargo.boxes.length === 0 && cargo.looseUnits === 0 && (
                  <div className="px-3 py-2 text-xs text-muted">Nothing has been counted in against it yet.</div>
                )}
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-muted mb-1">Bills</div>
              <div className="rounded-lg border border-cream-border overflow-hidden">
                {cargo.bills.map((b) => (
                  <div key={b.id} className="flex items-baseline justify-between gap-3 px-3 py-2 border-b border-cream-border last:border-b-0">
                    <span className="text-sm text-foreground">
                      {shortDate(b.date)} · {b.description || "Cargo"}
                      {b.method && <span className="text-xs text-muted"> · {b.method}</span>}
                    </span>
                    <span className="text-sm tabular-nums text-foreground">{fmt(b.amount)}</span>
                  </div>
                ))}
                {cargo.bills.length > 1 && (
                  <div className="flex items-baseline justify-between gap-3 px-3 py-2 bg-cream text-sm font-bold">
                    <span>Total</span><span className="tabular-nums">{fmt(cost)}</span>
                  </div>
                )}
                {cargo.bills.length === 0 && (
                  <div className="px-3 py-2 text-xs text-muted">
                    No bill points at this delivery yet, so it has no cost.
                  </div>
                )}
              </div>
              {/* Said plainly rather than offered as a button here: a bill is
                  attached where bills live, so there is one place to correct
                  one. Several bills for one delivery is simply several rows. */}
              <p className="mt-1 text-[11px] text-faint">
                The cost is the sum of these rows. Attach a bill to this delivery on
                Operational Expenses — the cargo stores no money of its own.
              </p>
            </div>

            <div className="flex items-end gap-2 flex-wrap">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">Weight (kg)</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={weight}
                  onChange={(e) => setWeight(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="—"
                  className="w-28 border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
                />
              </label>
              <button
                type="button"
                onClick={saveWeight}
                disabled={saving}
                className="h-10 rounded-lg border border-cream-border px-3 text-sm text-muted-strong bg-white hover:border-brand hover:text-brand disabled:opacity-40 transition-colors"
              >
                {saving ? "Saving…" : "Save weight"}
              </button>
              <span className="text-[11px] text-faint pb-2.5">the only figure the delivery keeps</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
