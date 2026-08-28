"use client"

import { useCallback, useEffect, useState } from "react"
import { fmt } from "@/lib/format"
import type { HeldDeposit } from "@/lib/db"

/**
 * Money she has already given you, offered on the invoice that would otherwise
 * ask for it again.
 *
 * She picks "keep it on my account" and the refund is filed with the money
 * still on it -- no payment written, because which order it lands on is the
 * shop's decision. Nothing then reminds anybody, so her next invoice is billed
 * in full while the credit sits two screens away on the Refunds page.
 *
 * Offered, never taken. Pressing applies it; not pressing leaves it hers,
 * because she may be saving it for something bigger. Same reasoning that keeps
 * refunds from creating themselves.
 */
export function DepositBanner({
  customer,
  event,
  outstanding,
  onApplied,
}: {
  customer: string
  event: string
  /** What she still owes on this trip. Nothing to offer against a settled one. */
  outstanding: number
  onApplied: () => void
}) {
  const [deposits, setDeposits] = useState<HeldDeposit[]>([])
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (outstanding <= 0) { setDeposits([]); return }
    let live = true
    fetch(`/api/sheets/deposits?customer=${encodeURIComponent(customer)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { deposits?: HeldDeposit[] }) => {
        if (!live) return
        // A credit from this very trip is the overpayment itself, not a deposit
        // to spend on it.
        setDeposits((d.deposits ?? []).filter((x) => x.fromEvent !== event))
      })
      // A banner that fails to load must not break the invoice under it.
      .catch(() => { if (live) setDeposits([]) })
    return () => { live = false }
  }, [customer, event, outstanding, nonce])

  const apply = useCallback(async (d: HeldDeposit) => {
    setBusy(d.refundId)
    setError(null)
    try {
      // Never more than she owes: the remainder stays on her account for the
      // next one rather than turning this invoice into a new overpayment.
      const amount = Math.min(d.amount, outstanding)
      const res = await fetch(`/api/sheets/refunds/${d.refundId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apply_credit", targetEvent: event, amount }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? "Gagal memakai deposit")
      setNonce((n) => n + 1)
      onApplied()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal memakai deposit")
    } finally {
      setBusy(null)
    }
  }, [event, outstanding, onApplied])

  if (deposits.length === 0) return null

  return (
    <div className="mx-4 my-3 rounded-lg border border-green-200 bg-green-50 p-3 flex flex-col gap-2">
      {deposits.map((d) => {
        const usable = Math.min(d.amount, outstanding)
        const over = d.amount > outstanding
        return (
          <div key={d.refundId} className="flex items-start gap-2.5">
            <span className="text-green-700 text-sm leading-none mt-0.5">💰</span>
            <div className="flex-1 min-w-0 text-xs">
              <div className="text-foreground">
                Dia punya deposit <b className="tabular-nums">Rp {fmt(d.amount)}</b> dari{" "}
                <b>{d.fromEvent}</b>
              </div>
              <div className="text-muted-strong mt-0.5">
                {over
                  ? `Rp ${fmt(usable)} menutup sisa tagihan ini; Rp ${fmt(d.amount - usable)} tetap di akunnya.`
                  : `Menutup Rp ${fmt(usable)} dari sisa tagihannya.`}
                {d.since && <span className="text-faint"> · sejak {d.since}</span>}
              </div>
            </div>
            <button
              type="button"
              onClick={() => apply(d)}
              disabled={busy !== null}
              className="shrink-0 px-2.5 py-1 rounded-lg bg-green-700 text-white text-[11px] font-medium hover:bg-green-800 disabled:opacity-50"
            >
              {busy === d.refundId ? "Memakai…" : `Pakai Rp ${fmt(usable)}`}
            </button>
          </div>
        )
      })}
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  )
}
