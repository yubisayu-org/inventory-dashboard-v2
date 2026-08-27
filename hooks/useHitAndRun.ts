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

/**
 * Who the text in a customer field might be, and what they carry.
 *
 * An exact handle is the answer when there is one. Otherwise it is a partial
 * handle -- somebody is still typing -- so a prefix match stands in, because a
 * warning that waits for the last character arrives after the name is already
 * chosen. Three characters minimum: "a" matches half the book and would cry
 * wolf on every order.
 *
 * Returns whom it matched, so an inexact hit can say whose mark it is rather
 * than implying it belongs to what was typed.
 */
export function marksFor(
  marks: Map<string, string[]>,
  text: string,
): { who: string; stamps: string[]; exact: boolean }[] {
  const key = handleKey(text)
  if (!key) return []

  const hit = marks.get(key)
  if (hit?.length) return [{ who: key, stamps: hit, exact: true }]

  if (key.length < 3) return []
  const out: { who: string; stamps: string[]; exact: boolean }[] = []
  for (const [who, stamps] of marks) {
    if (who.startsWith(key) && stamps.length) out.push({ who, stamps, exact: false })
  }
  return out
}
