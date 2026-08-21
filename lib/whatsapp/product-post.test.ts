import { test } from "node:test"
import assert from "node:assert/strict"
import { renderCaption } from "./product-post"

test("renders title, one line per code, and the reply instruction", () => {
  const caption = renderCaption(
    { title: "MUJI restock" },
    [
      { code: "K41", productName: "Boston Bag 38L Greige", price: 385000 },
      { code: "K42", productName: "Boston Bag 38L Black", price: 385000 },
    ],
  )
  assert.equal(
    caption,
    "📦 MUJI restock\n\n" +
    "K41 Boston Bag 38L Greige — Rp 385.000\n" +
    "K42 Boston Bag 38L Black — Rp 385.000\n\n" +
    "Reply kodenya ya, sertakan size/warna (jika ada), contoh: K42 warna putih size 38, mau 1",
  )
})

test("uses the first code in the example line, not always K42", () => {
  const caption = renderCaption({ title: "t" }, [{ code: "B07", productName: "Test", price: 1000 }])
  assert.ok(caption.includes("contoh: B07 warna putih size 38, mau 1"))
})

test("formats price with thousands separators, no decimals", () => {
  const caption = renderCaption({ title: "t" }, [{ code: "A01", productName: "Test", price: 1110000 }])
  assert.ok(caption.includes("Rp 1.110.000"))
})
