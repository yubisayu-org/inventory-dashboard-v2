// Pure product-pricing math — the single source of truth shared by the product
// forms (client) and any server-side use. No imports, so safe on both sides.

/** Round up to the nearest multiple of 5000. */
export function ceilTo5000(n: number): number {
  return Math.ceil(n / 5000) * 5000
}

export interface AbroadPriceInput {
  valas: number
  kurs: number
  gram: number
  cargoPerKg: number
  profitPct: number
  operationalFee: number
  packingFee: number
}

/**
 * Landed cost + selling price for an overseas product.
 *   COGS  = valas × kurs + (gram/1000) × cargoPerKg
 *   price = ceilTo5000( COGS × 100/(100−profit%) + opFee + packFee )
 * profit% ≥ 100 is invalid (would divide by ≤0), so price falls back to 0.
 */
export function calcAbroadPrice(p: AbroadPriceInput): { cogs: number; price: number } {
  const cogs = p.valas * p.kurs + (p.gram / 1000) * p.cargoPerKg
  if (p.profitPct >= 100) return { cogs, price: 0 }
  const raw = (cogs * 100) / (100 - p.profitPct) + p.operationalFee + p.packingFee
  return { cogs, price: ceilTo5000(raw) }
}

/** Per-unit profit for an overseas product = price − COGS − fees. */
export function abroadProfit(p: {
  price: number
  cogs: number
  operationalFee: number
  packingFee: number
}): number {
  return Math.round(p.price - p.cogs - p.operationalFee - p.packingFee)
}

/** Domestic price is just base cost plus a fixed profit. */
export function calcDomesticPrice(cost: number, profitFixed: number): number {
  return cost + profitFixed
}
