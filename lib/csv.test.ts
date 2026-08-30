import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCsv, csvField, toCsv } from "./csv"

test("a quoted field keeps its commas", () => {
  const rows = parseCsv('handle,area\nnita,"Pasar Kliwon, Surakarta"\n')
  assert.deepEqual(rows[1], ["nita", "Pasar Kliwon, Surakarta"])
})

test("doubled quotes are one quote", () => {
  assert.deepEqual(parseCsv('a\n"she said ""hi"""\n')[1], ['she said "hi"'])
})

test("Excel's line endings do not become part of a field", () => {
  const rows = parseCsv("a,b\r\n1,2\r\n")
  assert.deepEqual(rows[1], ["1", "2"])
})

test("a leading-zero postal code survives the round trip", () => {
  // Unquoted, Excel reads 06170 as a number and hands back 6170 — a postal
  // code that matches nothing and looks like a correction.
  const csv = toCsv([["kode_pos"], ["06170"]])
  assert.equal(csv.split("\n")[1], '"06170"')
  assert.equal(parseCsv(csv)[1][0], "06170")
})

test("an ordinary field is left unquoted", () => {
  assert.equal(csvField("PASAR KLIWON"), "PASAR KLIWON")
  assert.equal(csvField(18000), "18000")
  assert.equal(csvField(null), "")
})
