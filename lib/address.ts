/**
 * One address, six fields, and the string a courier reads.
 *
 * The shipping label prints `customers.data_diri` verbatim, and that column has
 * always been typed by hand: her name and phone written a second time, the
 * district written a third, and nothing forcing any of them to agree with the
 * columns beside them. The registration form already builds the same string
 * from parts -- it just throws the parts away afterwards.
 *
 * So the parts become the truth and the string is made from them. The label
 * code does not change: it still prints one column, which is now generated
 * rather than remembered.
 */

export type AddressParts = {
  name: string
  whatsapp: string
  /** Newlines kept: a street is often three lines, and they print as typed. */
  jalan: string
  kecamatan: string
  kota: string
  provinsi: string
  kodePos: string
  /**
   * The Biteship area, when she has one: "Limo, Depok, Jawa Barat. 16512".
   *
   * Preferred over the three columns for the district line, because it is the
   * same three names written the way a person writes them. Our own columns are
   * stored canonically and in capitals -- "JATISAMPURNA, KOTA BEKASI" -- which
   * is right for matching a rates table and shouty on a parcel. Her own postal
   * code still wins over the area's, since a district-only match carries a code
   * that belongs to the district rather than to her.
   */
  areaName: string
}

/**
 * The label, in the shape it has always had.
 *
 * Empty parts drop out rather than printing a blank line -- a customer with no
 * province gets the address she has now, not the same address with a hole in
 * it. That is what keeps the 3.000-odd existing labels identical after this
 * becomes generated.
 */
export function composeLabel(parts: Partial<AddressParts>): string {
  const street = (parts.jalan ?? "").split("\n").map((l) => l.trim()).filter(Boolean)
  const area = (parts.areaName ?? "").trim()
  const region = area
    ? area.replace(/\.?\s*\d{5}\s*$/, "").replace(/\.$/, "").trim()
    : [parts.kecamatan, parts.kota, parts.provinsi]
        .map((s) => (s ?? "").trim())
        .filter(Boolean)
        .join(", ")
  const postal = (parts.kodePos ?? "").trim() || area.match(/\b(\d{5})\b\s*$/)?.[1] || ""
  const regionLine = [region, postal].filter(Boolean).join(" ")

  const lines: string[] = []
  if (parts.name?.trim()) lines.push(`Nama: ${parts.name.trim()}`)
  if (parts.whatsapp?.trim()) lines.push(`Telepon: ${parts.whatsapp.trim()}`)
  if (street.length || regionLine) {
    lines.push("Alamat Lengkap:")
    lines.push(...street)
    if (regionLine) lines.push(regionLine)
  }
  return lines.join("\n")
}

/**
 * Whether the parts can say what the stored text says.
 *
 * A generated label must never be a worse label. Where the street is unknown --
 * a blob nobody could parse, an address imported from the spreadsheet era --
 * composing would print her district and nothing else, losing the house she
 * actually lives in. Those keep the text they print today until somebody fills
 * the street in.
 */
export function canCompose(parts: Partial<AddressParts>): boolean {
  return Boolean(parts.jalan?.trim() && (parts.kecamatan?.trim() || parts.kota?.trim()))
}

const HEADING = /^(nama|telepon|email|alamat lengkap)\s*:/i
const POSTAL = /\b(\d{5})\b\s*$/

/**
 * Pull the street and the province back out of a blob that was typed as one.
 *
 * The shape is known because the registration form wrote most of it: a heading
 * or two, "Alamat Lengkap:", the street, then a line naming her district. The
 * district line is the anchor -- it is the last line, it ends in a postal code
 * or names her city, and everything above it is the street.
 *
 * Returns nulls rather than guesses. A blob that does not have this shape is
 * one row for a person to look at, not one to overwrite.
 */
/**
 * The street, from a label that was stored in the street column.
 *
 * Returns null rather than guessing: a row this cannot read keeps what it has
 * and is listed at the end, because a wrong street ships a parcel to the wrong
 * place just as surely as a label does.
 */
export function recoverStreet(
  stored: string,
  known: { kecamatan?: string; kota?: string },
): string | null {
  let s = String(stored ?? "").replace(/[\r\n]+/g, " ").trim()

  // Everything up to and including the heading belongs to the label, not to
  // her address. No heading means this is not the shape we know how to read.
  const heading = /alamat\s*lengkap\s*:?/i.exec(s)
  if (!heading) return null
  s = s.slice(heading.index + heading[0].length)

  // The region tail. Her own district names where it starts; the city is the
  // fallback for a label that omitted the district. lastIndexOf because a
  // street can legitimately contain the district's name ("Jl. Limo Raya") and
  // the tail is the occurrence we want.
  for (const anchor of [known.kecamatan, known.kota].map((a) => (a ?? "").trim()).filter(Boolean)) {
    const at = s.toUpperCase().lastIndexOf(anchor.toUpperCase())
    if (at > 0) { s = s.slice(0, at); break }
  }

  s = s.replace(/[\s,.·•-]+$/, "").trim()
  // A couple of characters is not an address. Better left alone and reported.
  return s.length >= 4 ? s : null
}

export function parseAddressBlob(
  text: string,
  known: { kota?: string; kecamatan?: string; kodePos?: string } = {},
): { jalan: string | null; provinsi: string | null } {
  const raw = (text ?? "").split("\n").map((l) => l.trim())
  const afterHeading = raw.indexOf(raw.find((l) => /^alamat lengkap\s*:/i.test(l)) ?? "")
  const body = (afterHeading >= 0 ? raw.slice(afterHeading + 1) : raw)
    .filter((l) => l && !HEADING.test(l))
  if (body.length === 0) return { jalan: null, provinsi: null }

  // "Alamat: <street>" names itself, and then whatever follows is the district.
  const named = body.find((l) => /^alamat\s*:/i.test(l))
  if (named) {
    const rest = body.slice(body.indexOf(named) + 1)
    return {
      jalan: named.replace(/^alamat\s*:/i, "").trim() || null,
      provinsi: provinceOf(rest[rest.length - 1] ?? "", known),
    }
  }

  const last = body[body.length - 1]
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "")
  const looksLikeRegion =
    POSTAL.test(last) ||
    (known.kota ? norm(last).includes(norm(known.kota)) : false) ||
    (known.kecamatan ? norm(last).includes(norm(known.kecamatan)) : false)
  if (!looksLikeRegion || body.length < 2) return { jalan: null, provinsi: null }

  return {
    jalan: body.slice(0, -1).join("\n") || null,
    provinsi: provinceOf(last, known),
  }
}

/**
 * Indonesia has thirty-eight provinces, and this is the list.
 *
 * Named rather than inferred, because "whatever is left over" is not a
 * province: one customer's address ends "Pondok Aren, Tangsel 15421", where
 * Tangsel is her CITY abbreviated. Left to subtraction that lands in the
 * province field and prints on her parcel as though it were one.
 *
 * Written the way an address writes them, and matched on letters alone, so
 * "DI Yogyakarta", "D.I. Yogyakarta" and "Daerah Istimewa Yogyakarta" all
 * arrive at the same entry.
 */
const PROVINCES = [
  "Aceh", "Nanggroe Aceh Darussalam", "Sumatera Utara", "Sumatera Barat", "Riau",
  "Kepulauan Riau", "Jambi", "Sumatera Selatan", "Bangka Belitung",
  "Kepulauan Bangka Belitung", "Bengkulu", "Lampung", "DKI Jakarta", "Jakarta",
  "Jawa Barat", "Banten", "Jawa Tengah", "DI Yogyakarta", "Yogyakarta",
  "Daerah Istimewa Yogyakarta", "Jawa Timur", "Bali", "Nusa Tenggara Barat",
  "Nusa Tenggara Timur", "Kalimantan Barat", "Kalimantan Tengah",
  "Kalimantan Selatan", "Kalimantan Timur", "Kalimantan Utara",
  "Sulawesi Utara", "Gorontalo", "Sulawesi Tengah", "Sulawesi Barat",
  "Sulawesi Selatan", "Sulawesi Tenggara", "Maluku", "Maluku Utara",
  "Papua", "Papua Barat", "Papua Selatan", "Papua Tengah", "Papua Pegunungan",
  "Papua Barat Daya",
]
const PROVINCE_KEYS = new Map(
  PROVINCES.map((p) => [p.toUpperCase().replace(/[^A-Z0-9]/g, ""), p]),
)

/**
 * The province out of "Limo, Depok, Jawa Barat 16512".
 *
 * What is left once the postal code, the district and the city are taken out --
 * and then only if it is actually a province. A line that names only the two we
 * already know has none in it, which is most of them.
 */
function provinceOf(
  regionLine: string,
  known: { kota?: string; kecamatan?: string },
): string | null {
  const withoutPostal = regionLine.replace(POSTAL, "").trim().replace(/[,\s]+$/, "")
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "")
  const drop = new Set([norm(known.kota ?? ""), norm(known.kecamatan ?? "")].filter(Boolean))
  const left = withoutPostal
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    // "KOTA DEPOK" and "Depok" are the same segment to drop.
    .filter((s) => !drop.has(norm(s)) && ![...drop].some((d) => norm(s).includes(d) || d.includes(norm(s))))
  if (left.length !== 1) return null
  // Its own spelling back, not ours: "jawa barat" typed in an address becomes
  // "Jawa Barat" on the label.
  return PROVINCE_KEYS.get(left[0].toUpperCase().replace(/[^A-Z0-9]/g, "")) ?? null
}


/**
 * The four district fields an area already contains.
 *
 * "Limo, Depok, Jawa Barat. 16512" IS her kecamatan, kota, provinsi and kode
 * pos, so choosing one answers all four and nobody should type them again.
 *
 * `district` is the rates table's spelling of the same place, where it could be
 * found -- "LIMO, KOTA DEPOK" against Biteship's "Limo, Depok". It wins for the
 * two fields that price a parcel, because `lookupOngkir` matches those strings
 * exactly and not one of the 663 districts our customers live in exists under
 * Biteship's own words.
 */
export function fieldsFromArea(
  areaName: string,
  district: { kecamatan: string; kota: string } | null,
): { kecamatan: string; kota: string; provinsi: string; kodePos: string } {
  const kodePos = areaName.match(/\b(\d{5})\b\s*$/)?.[1] ?? ""
  const [kec = "", kota = "", provinsi = ""] = areaName
    .replace(/\.?\s*\d{5}\s*$/, "")
    .split(",")
    .map((p) => p.trim().replace(/\.$/, ""))
  return {
    kecamatan: district?.kecamatan ?? kec,
    kota: district?.kota ?? kota,
    provinsi,
    kodePos,
  }
}
