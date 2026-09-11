"use client"

import { useEffect, useState } from "react"
import type { SheetOptions } from "@/lib/db"

/**
 * The lists behind every picker: trips, products, customers, accounts.
 *
 * Three things keep this off the database. The browser revalidates with an
 * ETag, so an unchanged answer comes back as a 304 with no body. The server
 * keeps the last copy and only rebuilds it when one of the four tables has
 * been written to. And the copy below is shared by this tab: eleven screens
 * use this hook, several components on one screen use it at once, and each of
 * those used to be a full fetch of every product and every customer.
 */
let cached: SheetOptions | null = null
let inFlight: Promise<SheetOptions | null> | null = null
const listeners = new Set<(o: SheetOptions) => void>()

async function load(fresh = false): Promise<SheetOptions | null> {
  if (inFlight && !fresh) return inFlight
  inFlight = fetch(`/api/sheets/options${fresh ? "?fresh=1" : ""}`, { cache: "no-cache" })
    .then((r) => r.json())
    .then((data: SheetOptions & { error?: string }) => {
      if (data.error) return null
      cached = data
      for (const notify of listeners) notify(data)
      return data
    })
    .catch(() => null)
    .finally(() => { inFlight = null })
  return inFlight
}

/**
 * Throw the tab's copy away and fetch again.
 *
 * For the screens that add a product or a customer themselves: the revalidate
 * would notice within the second anyway, but the picker they just typed into
 * should not have to wait for a reload to show what they added.
 */
export function refreshSheetOptions(): void {
  cached = null
  // Forced past the write counters, which trail a commit by about a second --
  // and this is called in that second.
  void load(true)
}

export function useSheetOptions(): SheetOptions | null {
  const [options, setOptions] = useState<SheetOptions | null>(cached)

  useEffect(() => {
    let live = true
    const notify = (o: SheetOptions) => { if (live) setOptions(o) }
    listeners.add(notify)
    // Still revalidates when a copy is already held -- the request is a 304
    // when nothing has changed, and the point of holding it is that this
    // screen renders its pickers without waiting for one.
    void load()
    return () => { live = false; listeners.delete(notify) }
  }, [])

  return options
}
