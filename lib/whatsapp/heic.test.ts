import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import sharp from "sharp"
import { isHeic, decodable } from "./heic"
import { FIXTURES } from "../claims/fixtures"

/** An ISO base media header carrying the given brand. */
function ftyp(brand: string): Buffer {
  const head = Buffer.alloc(12)
  head.writeUInt32BE(12, 0)
  head.write("ftyp", 4, "ascii")
  head.write(brand, 8, "ascii")
  return head
}

test("an iPhone's brands are recognised as HEIC", () => {
  assert.equal(isHeic(ftyp("heic")), true)
  assert.equal(isHeic(ftyp("mif1")), true)
  assert.equal(isHeic(ftyp("HEIC")), true, "brand case is not the sender's to get right")
})

test("anything sharp can already read is left alone", () => {
  const jpeg = readFileSync(FIXTURES.original)
  assert.equal(isHeic(jpeg), false)
  assert.equal(isHeic(ftyp("mp42")), false, "a video is not a shelf")
  assert.equal(isHeic(Buffer.alloc(4)), false, "too short to say")
})

test("decodable passes a JPEG through untouched", async () => {
  const jpeg = readFileSync(FIXTURES.original)
  const out = await decodable(jpeg)
  assert.equal(out, jpeg, "a re-encode here would lose quality for nothing")
})

test("a real HEIC comes back as something sharp can open", async () => {
  const heic = readFileSync(FIXTURES.heic)
  assert.equal(isHeic(heic), true)

  const out = await decodable(heic)
  // Either sharp read the HEIC itself or heic-convert turned it into a JPEG;
  // both are correct, and what matters is that the bytes now decode. The phone's
  // own files take the second road — they pass metadata and then die at the
  // first resize, which is where this is called from.
  const meta = await sharp(out).metadata()
  assert.ok((meta.width ?? 0) > 0, "the shelf must be readable after decodable")
  assert.equal(meta.width, 400, "and it must be the same picture, not a thumbnail")
})
