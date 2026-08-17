import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeSize, sizesIn, alternativeSizes } from "./size"

test("a numeric size is found however it is introduced", () => {
  assert.equal(normalizeSize("size 90"), "90")
  assert.equal(normalizeSize("ukuran 100"), "100")
  assert.equal(normalizeSize("uk 80 ya kak"), "80")
  assert.equal(normalizeSize("yg bear itu size 95 ya kak, 1 aja"), "95")
  assert.equal(normalizeSize("90"), "90")
  assert.equal(normalizeSize("90cm"), "90")
})

test("letter sizes are recognised and upper-cased", () => {
  assert.equal(normalizeSize("mau yg L"), "L")
  assert.equal(normalizeSize("size xl"), "XL")
  assert.equal(normalizeSize("ukuran XXL dong"), "XXL")
})

test("a quantity is never mistaken for a size", () => {
  // "2" is how many they want, not what size. Baby-clothes sizes start at 50.
  assert.equal(normalizeSize("mau 2"), "")
  assert.equal(normalizeSize("2 ya kak"), "")
  assert.equal(normalizeSize("ambil 3"), "")
})

test("a number outside the clothing range is not a size", () => {
  assert.equal(normalizeSize("harga 1699"), "")
  assert.equal(normalizeSize("yg 200"), "")
})

test("nothing recognisable yields nothing, not a guess", () => {
  assert.equal(normalizeSize(""), "")
  assert.equal(normalizeSize("mau kak"), "")
  assert.equal(normalizeSize("yang itu ya"), "")
})

test("the first size wins when a note mentions two", () => {
  // "90 atau 95" is a customer hedging. The first is what they asked for; the
  // owner sees the raw note and can move the claim if the hedge mattered.
  assert.equal(normalizeSize("90 atau 95"), "90")
})

test("a bare letter that is really a word is not a size", () => {
  // "l" inside a word must not read as size L.
  assert.equal(normalizeSize("lucu banget"), "")
  assert.equal(normalizeSize("mau kalau ada"), "")
})

test("every size in a note is listed, in the order written", () => {
  assert.deepEqual(sizesIn("size 95, kalau nggak ada 100 juga boleh"), ["95", "100"])
  assert.deepEqual(sizesIn("M atau L boleh"), ["M", "L"])
  assert.deepEqual(sizesIn("size 90"), ["90"])
  assert.deepEqual(sizesIn("mau 2 pcs"), [], "a quantity is not a size, however many are listed")
})

test("a size repeated is listed once", () => {
  // "95 → Size 95" happens when a swap is undone by hand.
  assert.deepEqual(sizesIn("size 95 → Size 95"), ["95"])
})

test("alternatives are everything past the size she is filed under", () => {
  assert.deepEqual(alternativeSizes("size 95, kalau nggak ada 100 juga boleh"), ["100"])
  assert.deepEqual(alternativeSizes("size 95"), [], "no alternative is the normal case")
  assert.deepEqual(
    alternativeSizes("95 atau 100 atau 110"), ["100", "110"],
    "a customer may hedge more than once",
  )
})

test("a swapped note still reports the original as the size asked for", () => {
  // The note keeps her words and gains the agreement; the claim's own size
  // column is what actually moves it. Parsing must not quietly do that job.
  assert.equal(normalizeSize("Size 95 → Size 100"), "95")
  assert.deepEqual(sizesIn("Size 95 → Size 100"), ["95", "100"])
})
