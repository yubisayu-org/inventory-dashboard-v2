import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { FIXTURES } from "../claims/fixtures"
import { calcAbroadPrice, landedCost, type PricingMethod } from "../pricing"
import { getProductDefaults } from "../db/settings"
import { createPost, addClaim, setSlots, listSlots, setSlotBought } from "../db/claims"
import { nameSlot, addMissingOrders, unorderedClaims } from "./naming"
import { recluster } from "./ingest"

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

async function postWith(pricingMethod: PricingMethod | null, countryId: number | null) {
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

/** A slot on a post that is following the WhatsApp setting. */
async function inheritingSlot() {
  const { id: postId } = await postWith(null, JAPAN)
  const { id: claimId } = await addClaim({
    postId, sender: "1", customer: HANDLE, source: "ink", point: { x: 0.5, y: 0.5 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  await setSlots(postId, [
    { point: { x: 0.5, y: 0.5 }, variantId: null, size: "", claimIds: [claimId] },
  ])
  const [slot] = await listSlots(postId)
  return { postId, slot }
}

test("a post with no method of its own is priced by the WhatsApp setting", async () => {
  const { postId, slot } = await inheritingSlot()
  const expected = (await getProductDefaults()).whatsappPricingMethod

  const { productId } = await name({
    slotId: slot.id, name: `Inherited ${process.hrtime.bigint()}`, valas: 1699, gram: 250,
    // Target Price is the one method that cannot derive its own price. Sent
    // unconditionally: every other method ignores it.
    price: 450000,
  })

  const [product] = await sql`SELECT pricing_method FROM products WHERE id = ${productId}`
  assert.equal(product.pricing_method, expected, "the setting decides, not the capture-time copy")

  const [post] = await sql`SELECT pricing_method FROM wa_posts WHERE id = ${postId}`
  assert.equal(
    post.pricing_method, expected,
    "naming pins the method, so a later settings change cannot disagree with the orders",
  )
})

test("a post with a method of its own keeps it when named", async () => {
  const { id: postId } = await postWith("flat_fee", JAPAN)
  const { id: claimId } = await addClaim({
    postId, sender: "1", customer: HANDLE, source: "ink", point: { x: 0.5, y: 0.5 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  await setSlots(postId, [
    { point: { x: 0.5, y: 0.5 }, variantId: null, size: "", claimIds: [claimId] },
  ])
  const [slot] = await listSlots(postId)

  const { productId } = await name({
    slotId: slot.id, name: `Pinned ${process.hrtime.bigint()}`, valas: 1699, gram: 250,
  })

  const [product] = await sql`SELECT pricing_method FROM products WHERE id = ${productId}`
  assert.equal(product.pricing_method, "flat_fee")
  const [post] = await sql`SELECT pricing_method FROM wa_posts WHERE id = ${postId}`
  assert.equal(post.pricing_method, "flat_fee", "freezing must never overwrite a deliberate choice")
})

test("counting more after naming reaches the orders, not just the claims", async () => {
  const { slot } = await slotWithClaims([1, 1])
  // Only one of the two was in the basket when the slot was named.
  await setSlotBought(slot.id, 1)
  const { productId } = await name({
    slotId: slot.id, name: `Restocked ${process.hrtime.bigint()}`, valas: 1699, gram: 250,
  })

  // Back to the shop, second one found.
  await setSlotBought(slot.id, 2)

  const orders = await sql`
    SELECT unit_buy FROM orders WHERE product_id = ${productId} ORDER BY id
  `
  assert.deepEqual(
    orders.map((o) => o.unit_buy), [1, 1],
    "a unit counted after naming must land on its order, or the shopping list keeps asking for it",
  )
})

test("lowering the count after naming puts the order back on the shopping list", async () => {
  const { slot } = await slotWithClaims([1])
  await setSlotBought(slot.id, 1)
  const { productId } = await name({
    slotId: slot.id, name: `Returned ${process.hrtime.bigint()}`, valas: 1699, gram: 250,
  })

  // Miscounted: it was not in the basket after all.
  await setSlotBought(slot.id, 0)

  const [order] = await sql`SELECT unit_buy FROM orders WHERE product_id = ${productId}`
  assert.equal(order.unit_buy, null, "zero is written as NULL, the way an untouched order reads")
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

test("a claim arriving after naming still gets its order", async () => {
  const { slot } = await slotWithClaims([1])
  const { productId } = await name({
    slotId: slot.id, name: `Late Arrival ${process.hrtime.bigint()}`, valas: 1699, gram: 250,
  })

  // The rack is still in the group and the trip is still running, so somebody
  // claims it an hour after it was named.
  const [post] = await sql`SELECT post_id FROM wa_slots WHERE id = ${slot.id}`
  const { id: lateClaim } = await addClaim({
    postId: post.post_id as number, sender: "628119990123", customer: HANDLE, source: "ink",
    point: { x: 0.24, y: 0.78 }, variantId: null, quantity: 2, note: "mau 2",
    confidence: 1, state: "pending", messageId: "late",
  })
  await sql`UPDATE wa_claims SET slot_id = ${slot.id} WHERE id = ${lateClaim}`

  const result = await addMissingOrders(slot.id)
  assert.equal(result.added, 1, "the late claim is invoiced")

  const orders = await sql`SELECT unit FROM orders WHERE product_id = ${productId} ORDER BY unit`
  assert.deepEqual(orders.map((o) => o.unit), [1, 2])

  const again = await addMissingOrders(slot.id)
  assert.equal(again.added, 0, "running it twice adds nothing")
})

test("an unresolved late claim is counted, not invoiced to nobody", async () => {
  const { slot } = await slotWithClaims([1])
  await name({
    slotId: slot.id, name: `Unknown Sender ${process.hrtime.bigint()}`, valas: 100, gram: 10,
  })

  const [post] = await sql`SELECT post_id FROM wa_slots WHERE id = ${slot.id}`
  const { id: orphan } = await addClaim({
    postId: post.post_id as number, sender: "628119990999", customer: null, source: "ink",
    point: { x: 0.24, y: 0.78 }, variantId: null, quantity: 1, note: "",
    confidence: 1, state: "review", messageId: "orphan",
  })
  await sql`UPDATE wa_claims SET slot_id = ${slot.id} WHERE id = ${orphan}`

  const result = await addMissingOrders(slot.id)
  assert.equal(result.added, 0)
  assert.equal(result.blocked, 1, "somebody has to say who that number is first")
})

test("a late claim waits to be invoiced, and says that it is waiting", async () => {
  const { postId, slot } = await slotWithClaims([1])
  const { productId } = await name({
    slotId: slot.id, name: `Waiting ${process.hrtime.bigint()}`, valas: 1699, gram: 250,
  })

  // She claims the same peg an hour after the slot became a product.
  await addClaim({
    postId, sender: "628119990321", customer: HANDLE, source: "ink",
    point: { x: 0.24, y: 0.78 }, variantId: null, quantity: 2, note: "mau 2",
    confidence: 1, state: "pending", messageId: "late-a",
  })
  await recluster(postId)

  // Nothing is billed by arriving. Putting a line on an invoice is a decision,
  // and a claim that turns out to be junk is cheaper left un-ordered than
  // unpicked.
  const before = await sql`SELECT unit FROM orders WHERE product_id = ${productId}`
  assert.deepEqual(before.map((o) => o.unit), [1])

  // Re-read the slot: clustering rebuilds them, carrying the product across, so
  // the id a caller held before may not be the id that holds the claims now.
  const [current] = await listSlots(postId)
  assert.equal(current.productId, productId)

  // The claim is visible as unbilled, which is what the screen needs to offer
  // the fix.
  assert.deepEqual((await unorderedClaims(current.id)).length, 1)

  await addMissingOrders(current.id)
  const after = await sql`SELECT unit FROM orders WHERE product_id = ${productId} ORDER BY unit`
  assert.deepEqual(after.map((o) => o.unit), [1, 2])
  assert.deepEqual(await unorderedClaims(current.id), [], "and then nothing is waiting")
})
