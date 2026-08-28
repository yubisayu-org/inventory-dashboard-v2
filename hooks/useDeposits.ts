"use client"

import { useCallback, useEffect, useState } from "react"
import type { HeldDeposit } from "@/lib/db"

/**
 * Who is holding an unapplied credit, keyed by normalized handle.
 *
 * One fetch per page, shared by every row on it — the same rule the hit-and-run
 * marks follow, and for the same reason: asking per row turns one cheap read
 * into one per customer on screen.
 */
export function useDeposits(): { held: Map<string, HeldDeposit[]>; refresh: () => void } {
  const [held, setHeld] = useState<Map<string, HeldDeposit[]>>(new Map())
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let live = true
    fetch("/api/sheets/deposits", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { held?: Record<string, HeldDeposit[]> }) => {
        if (!live) return
        setHeld(new Map(Object.entries(d.held ?? {})))
      })
      // A marker that fails to load must not break the list it decorates.
      .catch(() => { if (live) setHeld(new Map()) })
    return () => { live = false }
  }, [nonce])

  return { held, refresh: useCallback(() => setNonce((n) => n + 1), []) }
}
