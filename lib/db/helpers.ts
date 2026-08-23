// Shared pure helpers used across the db/* modules.

/**
 * Canonical customer-handle form: trimmed, bare (no leading "@"), lowercase.
 * The single normalizer for both reads (matching) and writes (storage);
 * `normalizeCustomer` is an alias kept for write-side call sites.
 */
export function normalizeId(id: string | null | undefined): string {
  return String(id ?? "").trim().replace(/^@+/, "").toLowerCase()
}

function formatTimestamp(d: Date = new Date()): string {
  return d.toLocaleString("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function tsToString(v: Date | null | undefined): string {
  if (!v) return ""
  return formatTimestamp(v)
}

/** Normalize customer handle to the canonical form: bare lowercase, no "@". */
export function normalizeCustomer(raw: string): string {
  return normalizeId(raw)
}

/**
 * What sending the arrived part early adds to the bill.
 *
 * Two parcels are weighed and rounded separately, one is not — so the extra is
 * the difference between those two worlds, exactly as the merge discount is.
 * Zero when the rounding absorbs it, which happens more often than it sounds:
 * a 300g early parcel out of 1.2kg costs nothing extra to bill.
 */
export function splitExtraOngkir(
  lines: { gram: number; unit: number; toShip: number }[],
  ongkirPerKg: number,
): number {
  let nowGram = 0
  let fullGram = 0
  for (const l of lines) {
    nowGram += l.gram * l.toShip
    fullGram += l.gram * l.unit
  }
  const restGram = Math.max(0, fullGram - nowGram)
  if (nowGram <= 0 || restGram <= 0) return 0
  const apart = Math.ceil(nowGram / 1000) + Math.ceil(restGram / 1000)
  const together = Math.ceil(fullGram / 1000)
  return Math.max(0, ongkirPerKg * (apart - together))
}
