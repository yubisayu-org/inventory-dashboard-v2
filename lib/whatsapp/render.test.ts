import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sharp from "sharp"
import sql from "../db-pool"
import { FIXTURES } from "../claims/fixtures"
import { createPost, addClaim, setSlots, listSlots, setSlotLabel, setSlotBought } from "../db/claims"
import { renderShoppingList, SHOPPING_LIST_WIDTH } from "./render"

const EVENT = `TESTRENDER${process.hrtime.bigint()}`

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
})

after(async () => {
  await sql`DELETE FROM wa_posts WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

/** A post with two SKU at one position and one elsewhere. */
async function populatedPost() {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: FIXTURES.original, imageWidth: 1600, imageHeight: 2133,
    store: "Nishimatsuya", countryId: null, pricingMethod: "overseas", note: "", safeHues: [130],
  })
  const ids: number[] = []
  for (const [note, point] of [
    ["size 90", { x: 0.6, y: 0.47 }],
    ["size 95", { x: 0.6, y: 0.47 }],
    ["", { x: 0.24, y: 0.79 }],
  ] as const) {
    const { id } = await addClaim({
      postId, sender: "1", customer: null, source: "ink", point,
      variantId: null, quantity: 1, note, confidence: 1, state: "pending", messageId: "",
    })
    ids.push(id)
  }
  await setSlots(postId, [
    { point: { x: 0.6, y: 0.47 }, variantId: null, size: "90", claimIds: [ids[0]] },
    { point: { x: 0.6, y: 0.47 }, variantId: null, size: "95", claimIds: [ids[1]] },
    { point: { x: 0.24, y: 0.79 }, variantId: null, size: "", claimIds: [ids[2]] },
  ])
  const slots = await listSlots(postId)
  await setSlotLabel(slots[0].id, "Brown Bear Set")
  await setSlotLabel(slots[1].id, "Brown Bear Set")
  await setSlotLabel(slots[2].id, "Bunny Dressing Set")
  await setSlotBought(slots[0].id, 1)
  return { postId, slots }
}

test("the picture is the photo itself, with nothing appended below it", async () => {
  const { postId } = await populatedPost()
  const image = await renderShoppingList(postId)
  const meta = await sharp(image).metadata()

  assert.equal(meta.width, SHOPPING_LIST_WIDTH)
  // The fixture is 1600x2133, so the photo alone is 1200 tall at this width.
  // Anything taller means a panel crept back under it.
  assert.equal(meta.height, 1200)
  assert.equal(meta.format, "jpeg")
})

test("a post with no claims still renders, rather than failing", async () => {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: FIXTURES.original, imageWidth: 1600, imageHeight: 2133,
    store: "Nishimatsuya", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  const image = await renderShoppingList(postId)
  const meta = await sharp(image).metadata()
  assert.equal(meta.width, SHOPPING_LIST_WIDTH)
})

test("an unknown post is an error, not an empty image", async () => {
  await assert.rejects(() => renderShoppingList(0), /no such post/)
})
