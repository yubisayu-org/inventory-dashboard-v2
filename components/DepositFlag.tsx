"use client"

import { fmt } from "@/lib/format"
import type { HeldDeposit } from "@/lib/db"

/**
 * She is holding money you have not spent yet.
 *
 * Quiet, like the hit-and-run mark beside it: something to notice while reading
 * a list, not a verdict. What it is and where it came from are on the hover,
 * and the invoice underneath carries the button that applies it.
 */
export function DepositFlag({ deposits }: { deposits: HeldDeposit[] | undefined }) {
  if (!deposits || deposits.length === 0) return null
  const total = deposits.reduce((n, d) => n + d.amount, 0)
  const detail = deposits.map((d) => `Rp ${fmt(d.amount)} dari ${d.fromEvent}`).join("\n")
  return (
    <span
      title={`Deposit belum dipakai:\n${detail}`}
      aria-label={`Deposit Rp ${fmt(total)}`}
      className="shrink-0 text-green-700 text-xs leading-none cursor-help"
    >
      💰
    </span>
  )
}
