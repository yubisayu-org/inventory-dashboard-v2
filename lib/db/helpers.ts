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
 * What the real parcel plan costs against what the invoice already charged.
 *
 * One question covers every shipping wish, because they are all the same
 * question: her invoice bills ongkir per event on that event's full weight,
 * rounded up — and the parcels that actually leave are rarely those. So price
 * the parcels that will exist, subtract what has been billed, and the sign
 * tells you whether to charge or credit.
 *
 *   pair + wait    one box instead of two          → negative, the saving
 *   split, alone   two boxes instead of one        → positive, the second fee
 *   pair + early   one early box, one remainder    → whichever it works out to
 *
 * The remainder is one parcel, not one per event: a pairing survives a partial
 * shipment, so what is left still travels together. That is also why this can
 * be settled once — the whole plan is priced here, and nothing is asked for
 * again when the rest arrives.
 */
export function parcelPlanExtra(
  events: { lines: { gram: number; unit: number; toShip: number }[] }[],
  ongkirPerKg: number,
): number {
  let earlyGram = 0
  let restGram = 0
  let invoicedKg = 0
  for (const e of events) {
    let full = 0
    let now = 0
    for (const l of e.lines) {
      full += l.gram * l.unit
      now += l.gram * l.toShip
    }
    earlyGram += now
    restGram += Math.max(0, full - now)
    invoicedKg += Math.ceil(full / 1000)
  }
  const plannedKg =
    (earlyGram > 0 ? Math.ceil(earlyGram / 1000) : 0) + (restGram > 0 ? Math.ceil(restGram / 1000) : 0)
  return ongkirPerKg * (plannedKg - invoicedKg)
}

/**
 * The single-event case: sending part of one order early.
 *
 * Never negative — splitting one parcel into two cannot save anyone money,
 * and a zero means the rounding absorbed it, which is not something to bill.
 */
export function splitExtraOngkir(
  lines: { gram: number; unit: number; toShip: number }[],
  ongkirPerKg: number,
): number {
  const now = lines.reduce((g, l) => g + l.gram * l.toShip, 0)
  const rest = lines.reduce((g, l) => g + l.gram * (l.unit - l.toShip), 0)
  if (now <= 0 || rest <= 0) return 0
  return Math.max(0, parcelPlanExtra([{ lines }], ongkirPerKg))
}
