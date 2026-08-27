"use client"

import { useCallback, useEffect, useState } from "react"

/**
 * Who has walked away from an order, keyed by normalized handle.
 *
 * One fetch per page, shared by every row on it. The alternative -- asking per
 * customer as each row renders -- turns one cheap scan into dozens, which is
 * the only way this could become expensive.
 */
export function useHitAndRun(): {
  marks: Map<string, string[]>
  refresh: () => void
} {
  const [marks, setMarks] = useState<Map<string, string[]>>(new Map())
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let live = true
    fetch("/api/sheets/hit-and-run", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { rows?: { customer: string; stamps: string[] }[] }) => {
        if (!live) return
        setMarks(new Map((d.rows ?? []).map((r) => [r.customer, r.stamps])))
      })
      // A flag that fails to load must not break the page it decorates.
      .catch(() => { if (live) setMarks(new Map()) })
    return () => { live = false }
  }, [nonce])

  return { marks, refresh: useCallback(() => setNonce((n) => n + 1), []) }
}

/** Handles are stored however they were typed; this is the key the map uses. */
export function handleKey(customer: string): string {
  return customer.trim().toLowerCase().replace(/@/g, "")
}
