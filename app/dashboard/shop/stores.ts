export interface ShopPost {
  id: number
  event: string
  store: string
  sku: number
  claimed: number
  bought: number
}

export interface StoreGroup {
  key: string
  name: string
  posts: ShopPost[]
  left: number
}

/** The key two spellings of one shop name have to agree on. */
export const storeKey = (store: string) => (store.trim() || "Untitled shelf").toLowerCase()

/**
 * Shelves from one store, together.
 *
 * Store is typed by whoever opened the capture window, so "Nishimatsuya" and
 * "NISHIMATSUYA" are the same shop and must not become two sections. The name
 * shown is the first spelling seen rather than an upper-cased one, because the
 * heading is read by a person, not matched by a machine.
 */
export function groupByStore(posts: ShopPost[]): StoreGroup[] {
  const groups = new Map<string, StoreGroup>()

  for (const post of posts) {
    const name = post.store.trim() || "Untitled shelf"
    const key = storeKey(post.store)
    const group = groups.get(key) ?? { key, name, posts: [], left: 0 }
    group.posts.push(post)
    group.left += Math.max(0, post.claimed - post.bought)
    groups.set(key, group)
  }

  // Oldest shelf first inside a shop, which is the order they were photographed
  // in — and the order the racks stand in, because the photographs were taken
  // walking the aisle. Shopping the list top to bottom is then one walk rather
  // than a lap per shelf. Newest-first is right for an archive and wrong here.
  for (const group of groups.values()) group.posts.sort((a, b) => a.id - b.id)

  // Shops with something left first: you are standing in one of them.
  return [...groups.values()].sort((a, b) => {
    if ((a.left === 0) !== (b.left === 0)) return a.left === 0 ? 1 : -1
    return b.left - a.left
  })
}

export interface Neighbours {
  /** The shelf photographed before this one in the same shop, if any. */
  previous: ShopPost | null
  next: ShopPost | null
  /** Which shelf of the shop this is, 1-based, and how many there are. */
  position: number
  total: number
  store: string
}

/**
 * The shelves either side of this one, within its own shop.
 *
 * Walking a shop is one pass along the aisle, and the shelves were photographed
 * in that order, so "next" means the next rack rather than the next thing
 * posted anywhere. Crossing into another shop is never automatic: that is a
 * different building, and the list is the right place to choose it.
 */
export function neighbours(posts: ShopPost[], id: number): Neighbours | null {
  const here = posts.find((p) => p.id === id)
  if (!here) return null

  const group = groupByStore(posts).find((g) => g.key === storeKey(here.store))
  if (!group) return null

  const index = group.posts.findIndex((p) => p.id === id)
  return {
    previous: index > 0 ? group.posts[index - 1] : null,
    next: index < group.posts.length - 1 ? group.posts[index + 1] : null,
    position: index + 1,
    total: group.posts.length,
    store: group.name,
  }
}
