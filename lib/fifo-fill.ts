/**
 * Allocate `quantity` across `items` in input order. Each item is filled up to
 * its `getPending(item)` capacity before moving to the next. Leftover after all
 * items are saturated is reported as `excess`. Used by:
 *   - markProductBought / markProductArrived (lib/db.ts) — server-side allocation
 *   - shopping-list and arrival-list modal previews (clients) — live FIFO preview
 */
export function allocateFifo<T>(
  items: T[],
  getPending: (item: T) => number,
  quantity: number,
): {
  allocations: { item: T; allocated: number }[]
  unallocated: T[]
  excess: number
} {
  let remaining = quantity
  let totalPending = 0
  const allocations: { item: T; allocated: number }[] = []
  const unallocated: T[] = []

  for (const item of items) {
    const pending = getPending(item)
    totalPending += pending
    if (remaining <= 0 || pending <= 0) {
      unallocated.push(item)
      continue
    }
    const allocated = Math.min(pending, remaining)
    allocations.push({ item, allocated })
    remaining -= allocated
  }

  return { allocations, unallocated, excess: Math.max(0, quantity - totalPending) }
}
