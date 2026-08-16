import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { FIXTURES } from "../claims/fixtures"
import { calcAbroadPrice, landedCost, type PricingMethod } from "../pricing"
import { getProductDefaults } from "../db/settings"
import { createPost, addClaim, setSlots, listSlots, setSlotBought } from "../db/claims"
import { nameSlot } from "./naming"

const EVENT = `TESTNAME${process.hrtime.bigint()}`
const HANDLE = `testcust${process.hrtime.bigint()}`
/** JP: kurs 125, cargo 350000/kg. The price tag in a shelf photo is yen. */
const JAPAN = 2
/** Every product these tests create, so `after` can remove them again. */
const created: number[] = []

/** nameSlot, remembering what it made. */
async function name(input: Parameters<typeof nameSlot>[0]) {
  const result = await nameSlot(input)
  created.push(result.productId)
  return result
}

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  await sql`INSERT INTO customers (instagram_id) VALUES (${HANDLE}) ON CONFLICT DO NOTHING`
})

after(async () => {
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  // Products outlive the event that created them, so they need naming here.
  // Left behind they accumulate in a dev database that is never reset.
  if (created.length > 0) await sql`DELETE FROM products WHERE id IN ${sql(created)}`
  await sql`DELETE FROM wa_posts WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id = ${HANDLE}`
  await sql.end()
})

async function postWith(pricingMethod: PricingMethod, countryId: number | null) {
  return createPost({
    event: EVENT, imagePath: FIXTURES.original, imageWidth: 1600, imageHeight: 2133,
    store: "Nishimatsuya", countryId, pricingMethod, note: "", safeHues: [130],
  })
}

async function slotWithClaims(quantities: number[], customer: string | null = HANDLE) {
  const { id: postId } = await postWith("overseas", JAPAN)
  const claimIds: number[] = []
  for (const quantity of quantities) {
    const { id } = await addClaim({
      postId, sender: "628111019159", customer, source: "ink",
      point: { x: 0.24, y: 0.78 }, variantId: null, quantity,
      note: "", confidence: 1, state: "pending", messageId: "",
    })
    claimIds.push(id)
  }
  await setSlots(postId, [{ point: { x: 0.24, y: 0.78 }, variantId: null, size: "", claimIds }])
  const [slot] = await listSlots(postId)
  return { postId, slot }
}

test("naming creates a product carrying the post's context", async () => {
  const { slot } = await slotWithClaims([1])
  const { productId } = await name({
    slotId: slot.id, name: `Bunny Pajama ${process.hrtime.bigint()}`, valas: 1699, gram: 250,
  })

  const [product] = await sql`SELECT * FROM products WHERE id = ${productId}`
  assert.equal(product.store, "Nishimatsuya", "store comes from the post, not the typist")
  assert.equal(product.pricing_method, "overseas")
  assert.equal(Number(product.valas), 1699)
  assert.equal(product.gram, 250)
  assert.equal(product.country_id, JAPAN)
  assert.equal(Number(product.kurs), 125, "the rate comes from the post's country")
})

test("an overseas slot is priced by the same arithmetic the product form runs", async () => {
  const { slot } = await slotWithClaims([1])
  const { productId } = await name({
    slotId: slot.id, name: `Priced ${process.hrtime.bigint()}`, valas: 1699, gram: 250,
  })

  const defaults = await getProductDefaults()
  const expected = calcAbroadPrice({
    valas: 1699, kurs: 125, gram: 250, cargoPerKg: 350000,
    profitPct: defaults.profitPct,
    operationalFee: defaults.operationalFee,
    packingFee: defaults.packingFee,
    roundTo: defaults.profitMarginRoundTo,
  }).price

  const [product] = await sql`SELECT * FROM products WHERE id = ${productId}`
  assert.equal(product.price, expected)
  assert.ok(
    product.price > landedCost({ valas: 1699, kurs: 125, gram: 250, cargoPerKg: 350000 }),
    "a price at or below landed cost means the margin inputs never arrived",
  )
})

test("naming creates one order per claim, at the claimed quantity", async () => {
  const { slot } = await slotWithClaims([1, 2])
  const { orderCount } = await name({
    slotId: slot.id, name: `Daisy Set ${process.hrtime.bigint()}`, valas: 899, gram: 200,
  })
  assert.equal(orderCount, 2)

  const orders = await sql`SELECT * FROM orders WHERE event = ${EVENT} ORDER BY id DESC LIMIT 2`
  assert.deepEqual(orders.map((o) => o.unit).sort(), [1, 2])
  assert.ok(orders.every((o) => o.customer === HANDLE))
  assert.ok(orders.every((o) => o.unit_price > 0), "orders must not be written at price 0")
})

test("the slot remembers the product it was named as", async () => {
  const { postId, slot } = await slotWithClaims([1])
  const { productId } = await name({
    slotId: slot.id, name: `Shawl ${process.hrtime.bigint()}`, valas: 500, gram: 100,
  })
  const [named] = await listSlots(postId)
  assert.equal(named.productId, productId)
})

test("naming twice does not create a second product", async () => {
  const { slot } = await slotWithClaims([1])
  const first = await name({
    slotId: slot.id, name: `Once ${process.hrtime.bigint()}`, valas: 100, gram: 10,
  })
  await assert.rejects(
    () => nameSlot({ slotId: slot.id, name: "Twice", valas: 100, gram: 10 }),
    /already named/,
    "a named slot must refuse to be named again — orders would be duplicated",
  )
  assert.ok(first.productId > 0)
})

test("a claim with no resolved customer blocks naming rather than losing the order", async () => {
  const { slot } = await slotWithClaims([1], null)
  await assert.rejects(
    () => nameSlot({ slotId: slot.id, name: "Anything", valas: 1, gram: 1 }),
    /unresolved customer/,
  )
})

test("a post with no country cannot be named, because valas has no rate", async () => {
  const { id: postId } = await postWith("overseas", null)
  const { id: claimId } = await addClaim({
    postId, sender: "1", customer: HANDLE, source: "ink", point: { x: 0.5, y: 0.5 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  await setSlots(postId, [{ point: { x: 0.5, y: 0.5 }, variantId: null, size: "", claimIds: [claimId] }])
  const [slot] = await listSlots(postId)

  await assert.rejects(
    () => nameSlot({ slotId: slot.id, name: "Nowhere", valas: 1699, gram: 250 }),
    /no country/,
  )
})

test("a Target Price post needs the price typed, since nothing derives it", async () => {
  const { id: postId } = await postWith("target_price", JAPAN)
  const { id: claimId } = await addClaim({
    postId, sender: "1", customer: HANDLE, source: "ink", point: { x: 0.5, y: 0.5 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  await setSlots(postId, [{ point: { x: 0.5, y: 0.5 }, variantId: null, size: "", claimIds: [claimId] }])
  const [slot] = await listSlots(postId)

  await assert.rejects(
    () => nameSlot({ slotId: slot.id, name: "Untyped", valas: 1699, gram: 250 }),
    /needs a price/,
  )

  const { productId } = await name({
    slotId: slot.id, name: `Target ${process.hrtime.bigint()}`, valas: 1699, gram: 250,
    price: 450000,
  })
  const [product] = await sql`SELECT * FROM products WHERE id = ${productId}`
  assert.equal(product.price, 450000, "a Target Price is stored verbatim")
  assert.equal(product.cost, 299875, "cost is the landed cost the server derived")
})

test("what was bought in the shop lands on the orders naming creates", async () => {
  const { postId, slot } = await slotWithClaims([2, 1])
  // The owner got two of the three claimed, which by paid priority went to the
  // first claim (both customers rank equally, so arrival order decides).
  await setSlotBought(slot.id, 2)

  const { productId } = await name({
    slotId: slot.id, name: `Bought Already ${process.hrtime.bigint()}`, valas: 1699, gram: 250,
  })

  const orders = await sql`
    SELECT unit, unit_buy FROM orders WHERE product_id = ${productId} ORDER BY unit DESC
  `
  assert.equal(orders.length, 2)
  assert.equal(orders[0].unit, 2)
  assert.equal(orders[0].unit_buy, 2, "the claim that got units carries them onto its order")
  assert.equal(orders[1].unit, 1)
  assert.equal(orders[1].unit_buy ?? 0, 0, "the claim that missed out is recorded as unbought")
  assert.ok(postId > 0)
})

test("a size becomes part of the product name, as the catalogue spells it", async () => {
  const { postId } = await slotWithClaims([1])
  // Re-point that slot at a size, the way clustering would for "size 95".
  await sql`UPDATE wa_slots SET size = '95' WHERE post_id = ${postId}`
  const [sized] = await listSlots(postId)

  const stamp = process.hrtime.bigint()
  const { productId } = await name({
    slotId: sized.id, name: `Bear Set ${stamp}`, valas: 1699, gram: 250,
  })

  const [product] = await sql`SELECT name FROM products WHERE id = ${productId}`
  assert.equal(product.name, `Bear Set ${stamp} 95`)
})

test("a name that already ends in its size is not given it twice", async () => {
  const { postId } = await slotWithClaims([1])
  await sql`UPDATE wa_slots SET size = '95' WHERE post_id = ${postId}`
  const [sized] = await listSlots(postId)

  const stamp = process.hrtime.bigint()
  const { productId } = await name({
    slotId: sized.id, name: `Bear Set ${stamp} 95`, valas: 1699, gram: 250,
  })

  const [product] = await sql`SELECT name FROM products WHERE id = ${productId}`
  assert.equal(product.name, `Bear Set ${stamp} 95`)
})
