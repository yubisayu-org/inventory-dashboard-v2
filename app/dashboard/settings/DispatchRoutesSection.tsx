"use client"

import { useEffect, useState } from "react"
import { type DispatchRoute } from "@/lib/dispatch-modes"

// How a parcel's route is recognised. The receiving list reads the code off
// the front of a dispatch receipt — a box written "MNC-3109" is filed as sea
// cargo — so these are the codes staff actually write when packing.

const inputCls =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

export default function DispatchRoutesSection() {
  const [routes, setRoutes] = useState<DispatchRoute[] | null>(null)
  const [loadError, setLoadError] = useState("")
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetch("/api/sheets/dispatch-routes", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { routes?: DispatchRoute[]; error?: string }) => {
        if (d.error) setLoadError(d.error)
        else setRoutes(d.routes ?? [])
      })
      .catch(() => setLoadError("Failed to load shipping routes"))
  }, [])

  function field(key: string, patch: Partial<DispatchRoute>) {
    setRoutes((prev) => prev?.map((r) => (r.key === key ? { ...r, ...patch } : r)) ?? prev)
    setSaved(false)
  }

  async function handleSave() {
    if (!routes) return
    setSaving(true); setError(""); setSaved(false)
    try {
      const res = await fetch("/api/sheets/dispatch-routes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routes }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to save")
      setRoutes(data.routes ?? routes)
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-foreground">Shipping routes</h2>
        {saved && <span className="text-xs text-green-700">Saved</span>}
      </div>
      <p className="text-xs text-muted">
        The codes you write at the front of a dispatch receipt, separated by commas
        when a route answers to more than one. The receiving list reads them
        to file each parcel under a route — a box written <span className="font-mono">MNC-3109</span> is
        sea cargo — and to say when one is taking too long.
      </p>

      {loadError && <p className="text-xs text-red-500">{loadError}</p>}
      {routes === null && !loadError && <p className="text-sm text-faint">Loading…</p>}

      {routes && (
        <>
          <div className="hidden sm:grid grid-cols-[1fr_7rem_6rem_6rem] gap-2 text-[10px] font-bold uppercase tracking-wide text-muted px-1">
            <span>Route</span>
            <span>Codes</span>
            <span>Chase after</span>
            <span>Late after</span>
          </div>
          {routes.map((r) => (
            <div key={r.key} className="grid grid-cols-2 sm:grid-cols-[1fr_7rem_6rem_6rem] gap-2 items-center">
              <input
                value={r.label}
                onChange={(e) => field(r.key, { label: e.target.value })}
                className={inputCls}
                aria-label={`${r.key} name`}
              />
              {/* Comma-separated, because one route can answer to several
                  codes — the sea forwarder books under MNC and MU alike. Split
                  on save rather than on every keystroke, so a half-typed
                  "MNC, M" is not read as a code of its own while you type. */}
              <input
                value={r.prefixes.join(", ")}
                onChange={(e) =>
                  field(r.key, {
                    prefixes: e.target.value.toUpperCase().split(",").map((p) => p.trim()),
                  })
                }
                className={`${inputCls} font-mono`}
                aria-label={`${r.key} codes`}
                placeholder="MNC, MU"
              />
              {/* Days rather than weeks: a receipt is checked against a date,
                  and "56" is unambiguous where "8 weeks" invites rounding. */}
              <input
                type="number" min={1}
                value={r.warnDays}
                onChange={(e) => field(r.key, { warnDays: Number(e.target.value) })}
                className={inputCls}
                aria-label={`${r.key} chase after days`}
              />
              <input
                type="number" min={1}
                value={r.lateDays}
                onChange={(e) => field(r.key, { lateDays: Number(e.target.value) })}
                className={inputCls}
                aria-label={`${r.key} late after days`}
              />
            </div>
          ))}
          <p className="text-xs text-faint">
            Days since the parcel was dispatched. Under the first number its clock is green,
            past it amber, past the second red.
          </p>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button
            onClick={handleSave}
            disabled={saving}
            className="self-start px-4 py-2 rounded-lg bg-brand text-white text-sm font-semibold disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      )}
    </section>
  )
}
