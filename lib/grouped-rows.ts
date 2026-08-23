/**
 * Grouping a flat item list into the event → store → item tree the receiving
 * and dispatch tables draw, with the rowSpans those tables need.
 *
 * Lives here rather than beside the table because the rowSpan arithmetic and
 * the React key have to agree, and the only way to prove they do is to test
 * them. They did not agree: under a route tab the top-level group is the
 * PARCEL, so the event fell out of the row key, two events shipping the same
 * product in one parcel collided, React drew one row where the spans had
 * counted two, and every row below was pushed a column sideways.
 */

/** The least an item must carry to be grouped and identified. */
export type GroupableItem = { event: string; store: string; productId: number }

export type RowDescriptor<T> =
  | { type: "event-collapsed"; event: string; totalItems: number }
  | { type: "store-collapsed"; event: string; store: string; totalItems: number; showEvent: boolean; eventRowSpan?: number }
  | { type: "item"; item: T; event: string; store: string; showEvent: boolean; showStore: boolean; eventRowSpan?: number; storeRowSpan?: number }

/**
 * The row's identity, and React's key for it.
 *
 * `group` is whatever the table groups by at the top — the event under "All",
 * the parcel under a route — so it cannot stand in for the event. Both belong
 * here: drop either and two rows that must stay apart become one.
 */
export function rowKey(group: string, store: string, item: GroupableItem): string {
  return `${group}|${store}|${item.event}|${item.productId}`
}

export function groupItems<T extends GroupableItem>(
  items: T[],
  keyOf: (i: T) => string = (i) => i.event,
): Map<string, Map<string, T[]>> {
  const map = new Map<string, Map<string, T[]>>()
  for (const item of items) {
    const top = keyOf(item)
    if (!map.has(top)) map.set(top, new Map())
    const storeMap = map.get(top)!
    const key = item.store || "—"
    if (!storeMap.has(key)) storeMap.set(key, [])
    storeMap.get(key)!.push(item)
  }
  return map
}

export function buildRows<T extends GroupableItem>(
  grouped: Map<string, Map<string, T[]>>,
  collapsedEvents: Set<string>,
  collapsedStores: Set<string>,
): RowDescriptor<T>[] {
  const rows: RowDescriptor<T>[] = []

  for (const [event, storeMap] of grouped) {
    // Count and draw the SAME list. Deriving the spans from the raw group while
    // the render walked a de-duplicated one is exactly how the spans outgrew
    // their rows; taking both from `drawn` makes that impossible by
    // construction rather than by care.
    const drawn = new Map<string, T[]>()
    for (const [store, items] of storeMap) {
      const seen = new Set<string>()
      const kept: T[] = []
      for (const item of items) {
        const key = rowKey(event, store, item)
        if (seen.has(key)) continue
        seen.add(key)
        kept.push(item)
      }
      drawn.set(store, kept)
    }

    if (collapsedEvents.has(event)) {
      const totalItems = [...drawn.values()].reduce((s, arr) => s + arr.length, 0)
      rows.push({ type: "event-collapsed", event, totalItems })
      continue
    }

    let eventRowSpan = 0
    for (const [store, storeItems] of drawn) {
      eventRowSpan += collapsedStores.has(`${event}|${store}`) ? 1 : storeItems.length
    }

    let firstStoreOfEvent = true
    for (const [store, storeItems] of drawn) {
      if (collapsedStores.has(`${event}|${store}`)) {
        rows.push({
          type: "store-collapsed",
          event,
          store,
          totalItems: storeItems.length,
          showEvent: firstStoreOfEvent,
          eventRowSpan: firstStoreOfEvent ? eventRowSpan : undefined,
        })
        firstStoreOfEvent = false
        continue
      }

      storeItems.forEach((item, idx) => {
        const showEvent = firstStoreOfEvent && idx === 0
        rows.push({
          type: "item",
          item,
          event,
          store,
          showEvent,
          showStore: idx === 0,
          eventRowSpan: showEvent ? eventRowSpan : undefined,
          storeRowSpan: idx === 0 ? storeItems.length : undefined,
        })
        if (idx === 0) firstStoreOfEvent = false
      })
    }
  }

  return rows
}
