import { test } from "node:test"
import assert from "node:assert/strict"
import { recoverStreet } from "./address"

// The rows this repairs are labels that were stored as streets. The line
// parser in lib/address.ts cannot read them: the catalogue's text input had
// already stripped the newlines it splits on. Her own district is what says
// where the region tail begins.

test("a flattened label gives its street back", () => {
  assert.equal(
    recoverStreet(
      "Nama: Shinta MichikoTelepon: 447487779195Alamat Lengkap:"
      + "YVE Habitat B16, Jl. Pendowo RayaLimo, Depok 16512",
      { kecamatan: "Limo", kota: "Depok" },
    ),
    "YVE Habitat B16, Jl. Pendowo Raya",
  )
})

test("a label that kept its newlines works the same way", () => {
  assert.equal(
    recoverStreet(
      "Nama: A\nTelepon: 08123\nAlamat Lengkap:\nJl. Merdeka No. 10\nCOBLONG, KOTA BANDUNG 40132",
      { kecamatan: "COBLONG", kota: "KOTA BANDUNG" },
    ),
    "Jl. Merdeka No. 10",
  )
})

// A street may legitimately contain its own district's name.
test("the tail is cut at the last mention of the district, not the first", () => {
  assert.equal(
    recoverStreet(
      "Alamat Lengkap: Jl. Limo Raya No. 4 Limo, Depok 16512",
      { kecamatan: "Limo", kota: "Depok" },
    ),
    "Jl. Limo Raya No. 4",
  )
})

test("the city stands in when the district is not in the text", () => {
  assert.equal(
    recoverStreet("Alamat Lengkap: Jl. Mawar 9 Depok 16512", { kecamatan: "Cilodong", kota: "Depok" }),
    "Jl. Mawar 9",
  )
})

// Anything it cannot read keeps what it has. A wrong street ships a parcel to
// the wrong place as surely as a label does.
test("what it cannot read, it refuses", () => {
  // An ordinary street is not a label and never reaches this function, but if
  // it did there is no heading to cut at.
  assert.equal(recoverStreet("Jl. Sudirman 5", { kecamatan: "Limo", kota: "Depok" }), null)
  assert.equal(recoverStreet("", { kecamatan: "Limo" }), null)
  // Nothing left after the heading and the tail.
  assert.equal(recoverStreet("Alamat Lengkap: Limo, Depok 16512", { kecamatan: "Limo" }), null)
  // Too short to be an address.
  assert.equal(recoverStreet("Alamat Lengkap: Jl. Limo", { kecamatan: "Limo" }), null)
})
