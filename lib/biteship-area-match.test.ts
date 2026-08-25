import { test } from "node:test"
import assert from "node:assert/strict"
import { matchArea, normalisePlace } from "./biteship-area-match"
import type { BiteshipArea } from "./biteship"

const area = (id: string, name: string, postalCode?: string): BiteshipArea =>
  ({ id, name, postalCode })

// Biteship areas are per POSTAL CODE, so one kecamatan returns several. Matching
// on district and city alone calls that ambiguous and gives up — which is most
// districts in the country.
const CIMAHI_UTARA = [
  area("IDZ40511", "Cimahi Utara, Cimahi, Jawa Barat. 40511", "40511"),
  area("IDZ40512", "Cimahi Utara, Cimahi, Jawa Barat. 40512", "40512"),
  area("IDZ40513", "Cimahi Utara, Cimahi, Jawa Barat. 40513", "40513"),
]

test("the postal code picks one area out of a district that has several", () => {
  const r = matchArea(CIMAHI_UTARA, { kota: "CIMAHI", kecamatan: "CIMAHI UTARA", kodePos: "40512" })
  assert.equal(r.kind, "matched")
  assert.equal(r.kind === "matched" && r.area.id, "IDZ40512")
})

test("no postal code at all still resolves to the district", () => {
  // Same reasoning as a code nobody carries: one kecamatan, so one price.
  const r = matchArea(CIMAHI_UTARA, { kota: "CIMAHI", kecamatan: "CIMAHI UTARA", kodePos: "" })
  assert.equal(r.kind, "matched")
  assert.equal(r.kind === "matched" && r.approximate, true)
})

test("a postal code nobody carries falls back to the district, and says so", () => {
  // One kecamatan, several codes, ours not among them. The district is certain
  // even though the code is not, so it matches — flagged approximate, because
  // it is good enough to price against and not good enough to store as an
  // address.
  const r = matchArea(CIMAHI_UTARA, { kota: "CIMAHI", kecamatan: "CIMAHI UTARA", kodePos: "99999" })
  assert.equal(r.kind, "matched")
  assert.equal(r.kind === "matched" && r.approximate, true)
})

test("a district with exactly one area still matches without a postal code", () => {
  const one = [area("IDZ12345", "Sukajadi, Bandung, Jawa Barat. 40162", "40162")]
  const r = matchArea(one, { kota: "BANDUNG", kecamatan: "SUKAJADI", kodePos: "" })
  assert.equal(r.kind, "matched")
})

test("nothing resembling the place is not a match", () => {
  const r = matchArea(CIMAHI_UTARA, { kota: "SURABAYA", kecamatan: "GUBENG", kodePos: "60281" })
  assert.equal(r.kind, "none")
})

test("kabupaten, kota and punctuation are noise", () => {
  assert.equal(normalisePlace("KAB. BANDUNG BARAT"), "BANDUNG BARAT")
  assert.equal(normalisePlace("Kota Cimahi"), "CIMAHI")
})

test("the postal code is read from the area name when the field is absent", () => {
  // Some results carry the code only in the display name.
  const noField = [
    area("IDZ40511", "Cimahi Utara, Cimahi, Jawa Barat. 40511"),
    area("IDZ40512", "Cimahi Utara, Cimahi, Jawa Barat. 40512"),
  ]
  const r = matchArea(noField, { kota: "CIMAHI", kecamatan: "CIMAHI UTARA", kodePos: "40512" })
  assert.equal(r.kind, "matched")
  assert.equal(r.kind === "matched" && r.area.id, "IDZ40512")
})

// ── real failures from the production dry run ──────────────────────────────

test("an exact postal code decides it even when the city name does not line up", () => {
  // "KOTA ADM. JAKARTA UTARA" against "Jakarta Utara": the administrative
  // prefix is ours, not Biteship's, and the name comparison never got as far
  // as the postal code that already agreed.
  const areas = [
    area("A", "Kelapa Gading, Jakarta Utara, DKI Jakarta. 14240", "14240"),
    area("B", "Kelapa Gading, Jakarta Utara, DKI Jakarta. 14250", "14250"),
    area("C", "Koja, Jakarta Utara, DKI Jakarta. 14210", "14210"),
  ]
  const r = matchArea(areas, {
    kota: "KOTA ADM. JAKARTA UTARA", kecamatan: "KELAPA GADING", kodePos: "14250",
  })
  assert.equal(r.kind, "matched")
  assert.equal(r.kind === "matched" && r.area.id, "B")
})

test("a district spelled out in words still resolves on its postal code", () => {
  // "LUBUK LINGGAU TIMUR I" against "Lubuk Linggau Timur Satu (I)".
  const areas = [
    area("A", "Lubuk Linggau Timur Satu (I), Lubuk Linggau, Sumatera Selatan. 31625", "31625"),
    area("B", "Lubuk Linggau Timur Satu (I), Lubuk Linggau, Sumatera Selatan. 31628", "31628"),
    area("C", "Lubuk Linggau Barat Satu (I), Lubuk Linggau, Sumatera Selatan. 31611", "31611"),
  ]
  const r = matchArea(areas, {
    kota: "KOTA LUBUK LINGGAU", kecamatan: "LUBUK LINGGAU TIMUR I", kodePos: "31628",
  })
  assert.equal(r.kind, "matched")
  assert.equal(r.kind === "matched" && r.area.id, "B")
})

test("two areas sharing a postal code is still not a match", () => {
  const areas = [
    area("A", "Somewhere, Kota X, Prov. 11111", "11111"),
    area("B", "Elsewhere, Kota X, Prov. 11111", "11111"),
  ]
  const r = matchArea(areas, { kota: "KOTA Y", kecamatan: "NOWHERE", kodePos: "11111" })
  assert.notEqual(r.kind, "matched")
})

test("one district, several codes, none of them ours — take the district", () => {
  // Tapos, Depok: seven codes in our data, two in theirs. Every candidate is
  // the same kecamatan of the same kota, so they price the same; couriers
  // charge by district. Deterministic pick so re-runs do not wander.
  const areas = [
    area("B", "Tapos, Depok, Jawa Barat. 16464", "16464"),
    area("A", "Tapos, Depok, Jawa Barat. 16458", "16458"),
  ]
  const r = matchArea(areas, { kota: "KOTA DEPOK", kecamatan: "TAPOS", kodePos: "16414" })
  assert.equal(r.kind, "matched")
  assert.equal(r.kind === "matched" && r.area.id, "A", "lowest code, so the answer is stable")
  assert.equal(r.kind === "matched" && r.approximate, true)
})

test("two different districts is still a human decision", () => {
  // Only ONE kecamatan may be in play. Two districts that both happen to
  // contain the search words are exactly the case worth refusing.
  const areas = [
    area("A", "Tapos, Depok, Jawa Barat. 16458", "16458"),
    area("B", "Tapos Lama, Depok, Jawa Barat. 16464", "16464"),
  ]
  const r = matchArea(areas, { kota: "KOTA DEPOK", kecamatan: "TAPOS", kodePos: "16414" })
  assert.equal(r.kind, "ambiguous")
})

test("an exact match is never flagged approximate", () => {
  const r = matchArea(CIMAHI_UTARA, { kota: "CIMAHI", kecamatan: "CIMAHI UTARA", kodePos: "40512" })
  assert.equal(r.kind === "matched" && r.approximate, false)
})

test("a postal code may not move someone to a different district", () => {
  // Their kecamatan says Cimahi Utara; postal 40522 is Cimahi Tengah. One of
  // the two fields is wrong and we cannot tell which, so we do not choose.
  const areas = [
    ...CIMAHI_UTARA,
    area("T", "Cimahi Tengah, Cimahi, Jawa Barat. 40522", "40522"),
  ]
  const r = matchArea(areas, { kota: "KOTA CIMAHI", kecamatan: "CIMAHI UTARA", kodePos: "40522" })
  // Their district is certain, their code is not — so they stay in Cimahi Utara
  // and the answer is marked approximate, rather than being moved to a district
  // they never named.
  assert.equal(r.kind, "matched")
  assert.equal(r.kind === "matched" && r.approximate, true)
  assert.ok(
    r.kind === "matched" && r.area.name.startsWith("Cimahi Utara"),
    "must stay in the district they named",
  )
})

test("a differently spelled district is still the same district", () => {
  // "LUBUK LINGGAU TIMUR I" against "Lubuk Linggau Timur Satu (I)": every word
  // we have is there, so the postal code is allowed to settle it.
  const areas = [
    area("A", "Lubuk Linggau Timur Satu (I), Lubuk Linggau, Sumatera Selatan. 31628", "31628"),
    area("B", "Lubuk Linggau Barat Satu (I), Lubuk Linggau, Sumatera Selatan. 31611", "31611"),
  ]
  const r = matchArea(areas, {
    kota: "KOTA LUBUK LINGGAU", kecamatan: "LUBUK LINGGAU TIMUR I", kodePos: "31628",
  })
  assert.equal(r.kind, "matched")
  assert.equal(r.kind === "matched" && r.area.id, "A")
})
