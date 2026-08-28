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
  // A single refund id while one is being applied, "all" while the lot is.
  const [busy, setBusy] = useState<number | "all" | null>(null)
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

  const send = useCallback(async (refundId: number, amount: number) => {
    const res = await fetch(`/api/sheets/refunds/${refundId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "apply_credit", targetEvent: event, amount }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? "Gagal memakai deposit")
  }, [event])

  const apply = useCallback(async (d: HeldDeposit) => {
    setBusy(d.refundId)
    setError(null)
    try {
      // Never more than she owes: the remainder stays on her account for the
      // next one rather than turning this invoice into a new overpayment.
      await send(d.refundId, Math.min(d.amount, outstanding))
      setNonce((n) => n + 1)
      onApplied()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal memakai deposit")
    } finally {
      setBusy(null)
    }
  }, [send, outstanding, onApplied])

  /**
   * The lot, in one press.
   *
   * Oldest first, so a credit that has been sitting for months is spent before
   * one from last week, and stopping as soon as the invoice is covered — a
   * deposit bigger than the bill leaves its remainder on her account rather
   * than turning this invoice into a new overpayment.
   *
   * Still one credit payment per deposit underneath: the trail afterwards says
   * which trip paid for what, exactly as applying them by hand would.
   */
  const applyAll = useCallback(async () => {
    setBusy("all")
    setError(null)
    let left = outstanding
    try {
      for (const d of deposits) {
        if (left <= 0) break
        const amount = Math.min(d.amount, left)
        await send(d.refundId, amount)
        left -= amount
      }
      setNonce((n) => n + 1)
      onApplied()
    } catch (err) {
      // Whatever went through before the failure stands; the banner reloads to
      // show what is left rather than pretending none of it happened.
      setError(err instanceof Error ? err.message : "Gagal memakai deposit")
      setNonce((n) => n + 1)
      onApplied()
    } finally {
      setBusy(null)
    }
  }, [deposits, send, outstanding, onApplied])

  if (deposits.length === 0) return null

  const total = deposits.reduce((n, d) => n + d.amount, 0)
  const usableTotal = Math.min(total, outstanding)

  return (
    <div className="mx-4 my-3 rounded-lg border border-green-200 bg-green-50 p-3 flex flex-col gap-2">
      {/* Only where there is more than one. With a single deposit this button
          and the row's own would do the identical thing, differently worded. */}
      {deposits.length > 1 && (
        <div className="flex items-center gap-2.5 pb-2 border-b border-green-200">
          <span className="text-green-700 text-sm leading-none">💰</span>
          <div className="flex-1 min-w-0 text-xs">
            <div className="text-foreground">
              Total deposit <b className="tabular-nums">Rp {fmt(total)}</b> dari{" "}
              {deposits.length} refund
            </div>
            <div className="text-muted-strong mt-0.5">
              Dipakai dari yang paling lama dulu, berhenti kalau tagihannya sudah tertutup.
            </div>
          </div>
          <button
            type="button"
            onClick={applyAll}
            disabled={busy !== null}
            className="shrink-0 px-2.5 py-1 rounded-lg bg-green-700 text-white text-[11px] font-medium hover:bg-green-800 disabled:opacity-50"
          >
            {busy === "all" ? "Memakai…" : `Pakai semua Rp ${fmt(usableTotal)}`}
          </button>
        </div>
      )}

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
