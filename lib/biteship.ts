// Biteship Maps: turns typed text into a canonical area_id.
//
// Every call costs money (IDR 2 per request), and the search is reachable by
// any signed-in customer, so results are cached in-process. Area names change
// essentially never, which makes the cache hit rate very high and the steady-
// state cost close to zero.

const BASE = "https://api.biteship.com/v1"
const TIMEOUT_MS = 8000
const CACHE_TTL = 24 * 60 * 60 * 1000 // a day; place names do not move

export type BiteshipArea = {
  id: string
  name: string
  /** Present on some responses; absent is normal, so never required. */
  postalCode?: string
  administrativeDivisionLevel1Name?: string
  administrativeDivisionLevel2Name?: string
  administrativeDivisionLevel3Name?: string
}

const cache = new Map<string, { areas: BiteshipArea[]; ts: number }>()

export class BiteshipNotConfiguredError extends Error {}

function apiKey(): string {
  const key = process.env.BITESHIP_API_KEY
  if (!key) {
    throw new BiteshipNotConfiguredError("BITESHIP_API_KEY is not configured")
  }
  return key
}

/** Base URL is overridable so tests can point at a local mock. */
function baseUrl(): string {
  return process.env.BITESHIP_API_URL || BASE
}

function mapArea(raw: Record<string, unknown>): BiteshipArea {
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    postalCode: raw.postal_code != null ? String(raw.postal_code) : undefined,
    administrativeDivisionLevel1Name:
      raw.administrative_division_level_1_name != null
        ? String(raw.administrative_division_level_1_name)
        : undefined,
    administrativeDivisionLevel2Name:
      raw.administrative_division_level_2_name != null
        ? String(raw.administrative_division_level_2_name)
        : undefined,
    administrativeDivisionLevel3Name:
      raw.administrative_division_level_3_name != null
        ? String(raw.administrative_division_level_3_name)
        : undefined,
  }
}

export async function searchAreas(input: string): Promise<BiteshipArea[]> {
  const query = input.trim()
  // Below three characters the result set is enormous and useless, and every
  // keystroke would be billable.
  if (query.length < 3) return []

  const key = query.toLowerCase()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.areas

  const url = new URL(`${baseUrl()}/maps/areas`)
  url.searchParams.set("countries", "ID")
  url.searchParams.set("input", query)
  url.searchParams.set("type", "single")

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { authorization: apiKey(), accept: "application/json" },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Biteship maps returned ${res.status}`)
    const data = (await res.json()) as { areas?: Record<string, unknown>[] }
    const areas = (data.areas ?? []).map(mapArea).filter((a) => a.id && a.name)

    // Defensive bound: a determined caller could otherwise mint unbounded
    // cache keys by varying the query.
    if (cache.size > 2000) cache.clear()
    cache.set(key, { areas, ts: Date.now() })
    return areas
  } finally {
    clearTimeout(timer)
  }
}
