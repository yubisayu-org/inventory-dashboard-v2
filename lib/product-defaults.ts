// Default values pre-filled into the Add Product form (overseas pricing:
// profit %, operational fee, packing fee). Edited from /dashboard/settings —
// only changes what a *new* product form starts with, never touches existing
// products' stored values.

export interface ProductDefaults {
  profitPct: number
  operationalFee: number
  packingFee: number
  markupPct: number
}

export const DEFAULT_PRODUCT_DEFAULTS: ProductDefaults = {
  profitPct: 30,
  operationalFee: 5000,
  packingFee: 5000,
  markupPct: 5,
}
