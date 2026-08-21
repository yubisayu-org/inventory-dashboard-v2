import { NextRequest } from "next/server"

// Shared per-IP rate limiting for the public, no-login catalogue routes
// (app/api/public/catalogue/*). Originally lived only in
// estimate-price/route.ts; extracted so every public catalogue route gets
// its own independent counter without re-implementing the same sweep/cap
// logic. Each call to createRateLimiter() gets its own private Map, so
// e.g. the approve and reject routes don't share a rate-limit budget.

const RATE_LIMIT_MAP_SWEEP_THRESHOLD = 1000
// Hard cap below the sweep threshold: a script rotating its IP/XFF header
// faster than entries expire would otherwise keep the map growing forever
// even with the sweep, since sweeping only removes already-expired
// entries. If still over threshold post-sweep, drop oldest-inserted
// entries (Map iterates in insertion order) until back under it.
const RATE_LIMIT_MAP_HARD_CAP = 1000

/** Builds an independent rate limiter: `max` requests per `windowMs` per
 *  IP, its own Map so callers don't share a budget. */
export function createRateLimiter(windowMs: number, max: number): (ip: string) => boolean {
  const rateLimitMap = new Map<string, { windowStart: number; count: number }>()

  return function isRateLimited(ip: string): boolean {
    const now = Date.now()
    if (rateLimitMap.size > RATE_LIMIT_MAP_SWEEP_THRESHOLD) {
      for (const [key, entry] of rateLimitMap) {
        if (now - entry.windowStart > windowMs) rateLimitMap.delete(key)
      }
      if (rateLimitMap.size > RATE_LIMIT_MAP_HARD_CAP) {
        const excess = rateLimitMap.size - RATE_LIMIT_MAP_HARD_CAP
        const oldestKeys = Array.from(rateLimitMap.keys()).slice(0, excess)
        for (const key of oldestKeys) rateLimitMap.delete(key)
      }
    }
    let entry = rateLimitMap.get(ip)
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { windowStart: now, count: 1 }
      rateLimitMap.set(ip, entry)
      return false
    }
    entry.count++
    return entry.count > max
  }
}

// Secondary defense only — keys on the last X-Forwarded-For hop (the one
// this app's own edge proxy appends, not one a client can inject by
// prepending fake entries), falling back to a platform real-IP header if
// present.
export function clientIp(req: NextRequest): string {
  // x-envoy-external-address is only a fallback: it's trustworthy only if
  // the edge actually sets it, which isn't verified here — see the
  // estimate-price route's block comment for the open topology question.
  const xff = req.headers.get("x-forwarded-for")
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim())
    const last = hops[hops.length - 1]
    if (last) return last
  }
  const envoyIp = req.headers.get("x-envoy-external-address")
  if (envoyIp) return envoyIp
  return "unknown"
}
