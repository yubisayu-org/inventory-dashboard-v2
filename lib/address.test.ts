import { test } from "node:test"
import assert from "node:assert/strict"
import { composeLabel, canCompose, parseAddressBlob, fieldsFromArea } from "./address"

test("the label reads the way it always has", () => {
  assert.equal(
    composeLabel({
      name: "Shinta Michiko", whatsapp: "447487779195",
      jalan: "YVE Habitat B16, Jl. Pendowo Raya",
      kecamatan: "Limo", kota: "Depok", provinsi: "Jawa Barat", kodePos: "16512",
    }),
    "Nama: Shinta Michiko\nTelepon: 447487779195\nAlamat Lengkap:\n" +
    "YVE Habitat B16, Jl. Pendowo Raya\nLimo, Depok, Jawa Barat 16512",
  )
})

test("a street of three lines prints as three lines", () => {
  const out = composeLabel({
    name: "A", jalan: "Memora House\nCluster Milestone No. F09\nJl. Bambu Apus",
    kecamatan: "Pamulang", kota: "Tangerang Selatan", kodePos: "15415",
  })
  assert.match(out, /Memora House\nCluster Milestone No\. F09\nJl\. Bambu Apus\nPamulang/)
})

test("a missing province leaves no hole", () => {
  // 3.000-odd labels have no province today. Generated, they must come out the
  // same, not the same with a gap where one would be.
  const out = composeLabel({
    name: "Almira Desti", whatsapp: "6281232699723",
    jalan: "Fortune Terrace D6/L5. Graha Raya",
    kecamatan: "Ciledug", kota: "KOTA TANGERANG", kodePos: "15152",
  })
  assert.equal(out.split("\n").pop(), "Ciledug, KOTA TANGERANG 15152")
})

test("nothing is composed without a street", () => {
  // Composing here would print her district and lose the house she lives in.
  assert.equal(canCompose({ kecamatan: "Limo", kota: "Depok" }), false)
  assert.equal(canCompose({ jalan: "Jl. Mawar 1", kota: "Depok" }), true)
})

// ─── Getting the parts back out of the blob ─────────────────────────────────

test("the street is what sits above the district line", () => {
  const r = parseAddressBlob(
    "Nama: Almira Desti\nTelepon: 6281232699723\nAlamat Lengkap:\n" +
    "Fortune Terrace D6/L5. Graha Raya\nCiledug, KOTA TANGERANG 15152",
    { kota: "KOTA TANGERANG", kecamatan: "CILEDUG", kodePos: "15152" },
  )
  assert.equal(r.jalan, "Fortune Terrace D6/L5. Graha Raya")
  assert.equal(r.provinsi, null)
})

test("a province in the district line is picked up", () => {
  const r = parseAddressBlob(
    "Nama: X\nAlamat Lengkap:\nPuri Depok Mas 3 Blok PF No 8\n" +
    "Pancoran Mas, Kota Depok, Jawa Barat 16436",
    { kota: "KOTA DEPOK", kecamatan: "PANCORAN MAS", kodePos: "16436" },
  )
  assert.equal(r.jalan, "Puri Depok Mas 3 Blok PF No 8")
  assert.equal(r.provinsi, "Jawa Barat")
})

test("a street written over several lines comes back whole", () => {
  const r = parseAddressBlob(
    "Nama: X\nAlamat Lengkap:\nMemora House\nCluster Milestone No. F09\n" +
    "Jl. Bambu Apus\nPamulang, Tangerang Selatan 15415",
    { kota: "TANGERANG SELATAN", kecamatan: "PAMULANG", kodePos: "15415" },
  )
  assert.equal(r.jalan, "Memora House\nCluster Milestone No. F09\nJl. Bambu Apus")
})

test("an Alamat: line names the street itself", () => {
  const r = parseAddressBlob(
    "Nama: X\nAlamat Lengkap:\nAlamat: Elysian Residence Kav. No:26\n" +
    "PASAR MINGGU, KOTA ADM. JAKARTA SELATAN 12520",
    { kota: "KOTA ADM. JAKARTA SELATAN", kecamatan: "PASAR MINGGU" },
  )
  assert.equal(r.jalan, "Elysian Residence Kav. No:26")
})

test("a blob with no shape is refused rather than guessed at", () => {
  // One row in production reads as a single run-on line. Taking a street out of
  // it would be inventing one.
  const r = parseAddressBlob(
    "jl alam pesanggrahan 6 blok OH 6, Bukit cinere Indah jawa barat kota depok kec cinere 16514",
    { kota: "KOTA DEPOK", kecamatan: "CINERE" },
  )
  assert.equal(r.jalan, null)
})

test("an email line is not part of the street", () => {
  const r = parseAddressBlob(
    "Nama: X\nTelepon: 08\nAlamat Lengkap:\nJl. Mawar 1\nLimo, Depok 16512\nEmail: x@y.z",
    { kota: "Depok", kecamatan: "Limo" },
  )
  assert.equal(r.jalan, "Jl. Mawar 1")
})

test("the area writes the district line, because it is written for people", () => {
  // Our own columns are canonical and in capitals — right for matching a rates
  // table, shouty on a parcel. The area says the same three names the way a
  // person writes them.
  const out = composeLabel({
    name: "Amira", jalan: "Butik Cibubur Living Kav. 3A",
    kecamatan: "JATISAMPURNA", kota: "KOTA BEKASI", kodePos: "17435",
    areaName: "Jati Sampurna, Bekasi, Jawa Barat. 17435",
  })
  assert.equal(out.split("\n").pop(), "Jati Sampurna, Bekasi, Jawa Barat 17435")
})

test("her own postal code beats the area's", () => {
  // A district-only match carries a code belonging to the district, not to her.
  const out = composeLabel({
    name: "A", jalan: "Jl. Mawar 1", kodePos: "17510",
    areaName: "Tambun Selatan, Bekasi, Jawa Barat. 17511",
  })
  assert.equal(out.split("\n").pop(), "Tambun Selatan, Bekasi, Jawa Barat 17510")
})

// ─── Choosing an area answers the four fields ───────────────────────────────

test("the rates table's spelling wins for the two fields that price", () => {
  const f = fieldsFromArea("Limo, Depok, Jawa Barat. 16512",
    { kecamatan: "LIMO", kota: "KOTA DEPOK" })
  assert.deepEqual(f, { kecamatan: "LIMO", kota: "KOTA DEPOK", provinsi: "Jawa Barat", kodePos: "16512" })
})

test("without one, the courier's own words are used rather than nothing", () => {
  // Visibly unpriced in the ongkir check beats an empty address.
  const f = fieldsFromArea("Nowhere, Somewhere, Kalimantan Barat. 79100", null)
  assert.equal(f.kecamatan, "Nowhere")
  assert.equal(f.kota, "Somewhere")
})

test("an area with no province still answers the rest", () => {
  const f = fieldsFromArea("Limo, Depok. 16512", { kecamatan: "LIMO", kota: "KOTA DEPOK" })
  assert.equal(f.provinsi, "")
  assert.equal(f.kodePos, "16512")
})

test("a city abbreviation is not a province", () => {
  // "Pondok Aren, Tangsel 15421" — Tangsel is Tangerang Selatan, her city.
  // Subtraction leaves it standing where a province would be, and it would
  // have printed on her parcel as one.
  const r = parseAddressBlob(
    "Nama: X\nAlamat Lengkap:\nKomplek Edelweis Blok B23\nPondok Aren, Tangsel 15421",
    { kota: "KOTA TANGERANG SELATAN", kecamatan: "PONDOK AREN", kodePos: "15421" },
  )
  assert.equal(r.jalan, "Komplek Edelweis Blok B23")
  assert.equal(r.provinsi, null)
})

test("a province comes back in its own spelling", () => {
  const r = parseAddressBlob(
    "Nama: X\nAlamat Lengkap:\nJl. Mawar 1\nSekupang, Batam, kepulauan riau 29426",
    { kota: "KOTA BATAM", kecamatan: "SEKUPANG", kodePos: "29426" },
  )
  assert.equal(r.provinsi, "Kepulauan Riau")
})
