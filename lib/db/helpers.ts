// Shared pure helpers used across the db/* modules.

export function normalizeId(id: string | null | undefined): string {
  return String(id ?? "").replace(/^@/, "").toLowerCase()
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
  return raw.trim().toLowerCase().replace(/^@+/, "")
}

/** Round up to the nearest multiple of 5000 */
export function ceilTo5000(n: number): number {
  return Math.ceil(n / 5000) * 5000
}

/** Calculate abroad product price from cost breakdown */
export function calcAbroadPrice(input: {
  valas: number
  kurs: number
  gramWeight: number
  cargoPerKg: number
  profitPct: number
  operationalFee: number
  packingFee: number
}): { cogs: number; rawPrice: number; price: number } {
  const cogs =
    input.valas * input.kurs +
    (input.gramWeight / 1000) * input.cargoPerKg
  const rawPrice =
    (cogs * 100) / (100 - input.profitPct) +
    input.operationalFee +
    input.packingFee
  return { cogs, rawPrice, price: ceilTo5000(rawPrice) }
}
