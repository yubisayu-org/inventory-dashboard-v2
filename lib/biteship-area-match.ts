import type { BiteshipArea } from "./biteship"

/**
 * Choosing which Biteship area an address means.
 *
 * Biteship's areas are per POSTAL CODE, not per district: one kecamatan comes
 * back as several areas that differ only by the code on the end. Matching on
 * district and city alone therefore finds three equally good answers for most
 * of the country and, quite correctly, refuses to guess — which is why so few
 * addresses ever resolved. The postal code is the field that separates them,
 * and it has been sitting in customers.kode_pos the whole time.
 *
 * Its own file so the choosing can be tested without a database or a billable
 * request behind it.
 */

/** Strip the noise that differs between local spelling and Biteship's naming. */
export function normalisePlace(s: string): string {
  return s
    .toUpperCase()
    .replace(/\bKAB(UPATEN)?\.?\b/g, "")
    .replace(/\bKOTA\b/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export type Place = { kota: string; kecamatan: string; kodePos: string }

export type AreaMatch =
  /**
   * `approximate` means the district was certain but the exact postal code was
   * not: Biteship carries a different set of codes for it than our addresses
   * use. Couriers price by district, so the rate is the same either way — but
   * the caller is told, because "the right district" and "the right area" are
   * not the same claim.
   */
  | { kind: "matched"; area: BiteshipArea; approximate: boolean }
  /** Nothing resembled the place at all. */
  | { kind: "none" }
  /** Several areas fit and nothing separates them — a human decides. */
  | { kind: "ambiguous"; candidates: BiteshipArea[] }

/** The district a Biteship area names, e.g. "Cimahi Utara" of "Cimahi Utara, Cimahi. 40512". */
function districtOf(area: BiteshipArea): string {
  return normalisePlace(area.name.split(",")[0] ?? "")
}

/**
 * Whether an area's district is plausibly the one we mean.
 *
 * Every word we have must be in theirs. "Lubuk Linggau Timur I" against their
 * "Lubuk Linggau Timur Satu (I)" passes — the extra "Satu" is theirs to add.
 * "Cimahi Utara" against "Cimahi Tengah" fails on UTARA, which is the whole
 * point: those are different places that merely share a city.
 */
function sameDistrict(area: BiteshipArea, wantKec: string): boolean {
  const theirs = districtOf(area).split(" ").filter(Boolean)
  return wantKec
    .split(" ")
    .filter(Boolean)
    .every((word) => theirs.includes(word))
}

/** Five digits at the end of a name, e.g. "Cimahi Utara, Cimahi. 40512". */
function postalOf(area: BiteshipArea): string {
  if (area.postalCode) return area.postalCode.trim()
  return area.name.match(/\b(\d{5})\b\s*$/)?.[1] ?? ""
}

/**
 * The area an address means, or an honest refusal.
 *
 * A wrong area is a wrong shipping price for everyone in that district, and it
 * would be silent — so anything less than one clear answer is handed back for a
 * person to settle rather than guessed at.
 */
export function matchArea(areas: BiteshipArea[], place: Place): AreaMatch {
  const wantKec = normalisePlace(place.kecamatan)
  const wantKota = normalisePlace(place.kota)

  const wantPos = place.kodePos.trim()

  const strong = areas.filter((a) => {
    const n = normalisePlace(a.name)
    return n.includes(wantKec) && n.includes(wantKota)
  })

  // The names agree and only the postal code separates them.
  if (strong.length === 1) return { kind: "matched", area: strong[0], approximate: false }
  if (strong.length > 1 && wantPos) {
    const byPostal = strong.filter((a) => postalOf(a) === wantPos)
    if (byPostal.length === 1) return { kind: "matched", area: byPostal[0], approximate: false }
  }

  // The names do NOT agree, but a postal code might still settle it, and often
  // does: our spelling carries administrative noise Biteship has no reason to
  // share — "KOTA ADM. JAKARTA UTARA" for their "Jakarta Utara", "LUBUK
  // LINGGAU TIMUR I" for their "Lubuk Linggau Timur Satu (I)". A code that
  // appears exactly once in the results of a search for THIS district is a
  // stronger signal than a spelling comparison, because it is the one field
  // both sides write the same way.
  //
  // Exactly once: two areas sharing a code means the code has not chosen
  // between them, and a wrong area is a wrong price for everyone in it.
  //
  // The code may correct our SPELLING of a district; it may not move someone to
  // a different one. A customer whose kecamatan reads "Cimahi Utara" with a
  // postal code belonging to Cimahi Tengah has one wrong field and nothing here
  // can say which, so that stays a human decision.
  if (wantPos) {
    const byPostal = areas.filter((a) => postalOf(a) === wantPos && sameDistrict(a, wantKec))
    if (byPostal.length === 1) return { kind: "matched", area: byPostal[0], approximate: false }
  }

  if (strong.length === 0) return { kind: "none" }

  // Every candidate is the same district of the same city, and only the postal
  // code separates them — a code Biteship does not carry for it. The district
  // is what a courier prices, so any of them gives the same rate. Lowest code
  // wins purely so the answer does not move between runs.
  const districts = new Set(strong.map(districtOf))
  if (districts.size === 1) {
    const pick = [...strong].sort((a, b) => postalOf(a).localeCompare(postalOf(b)))[0]
    return { kind: "matched", area: pick, approximate: true }
  }

  return { kind: "ambiguous", candidates: strong }
}
