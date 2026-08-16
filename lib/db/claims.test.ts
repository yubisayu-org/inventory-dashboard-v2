import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { createPost, getPost, addClaim, listClaims, setSlots, listSlots, setSlotBought, setSlotLabel, markClaimObtained } from "./claims"

const EVENT = `TEST${process.hrtime.bigint()}`

before(async () => {
  // events.warehouse_id is NOT NULL; any existing warehouse will do, since
  // nothing here reads it back.
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
})

after(async () => {
  // wa_posts cascades to claims and slots.
  await sql`DELETE FROM wa_posts WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

test("a post round-trips with everything a slot inherits", async () => {
  const { id } = await createPost({
    event: EVENT,
    imagePath: "test/shelf.jpg",
    imageWidth: 1600,
    imageHeight: 2133,
    store: "Nishimatsuya",
    countryId: null,
    pricingMethod: "tier_kurs",
    note: "",
    safeHues: [130, 280],
  })

  const post = await getPost(id)
  assert.ok(post)
  assert.equal(post.store, "Nishimatsuya")
  assert.equal(post.pricingMethod, "tier_kurs")
  assert.deepEqual(post.safeHues, [130, 280])
})

test("claims record a position and survive re-reading", async () => {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: "test/a.jpg", imageWidth: 100, imageHeight: 100,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })

  await addClaim({
    postId, sender: "628111019159", customer: null, source: "ink",
    point: { x: 0.24, y: 0.78 }, variantId: null, quantity: 1,
    note: "size 90", confidence: 1, state: "pending", messageId: "msg-1",
  })

  const claims = await listClaims(postId)
  assert.equal(claims.length, 1)
  assert.equal(claims[0].sender, "628111019159")
  assert.equal(claims[0].note, "size 90")
  assert.ok(Math.abs((claims[0].point?.x ?? 0) - 0.24) < 1e-9)
})

test("setSlots replaces slots and points claims at them", async () => {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: "test/b.jpg", imageWidth: 100, imageHeight: 100,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  const a = await addClaim({
    postId, sender: "1", customer: null, source: "ink", point: { x: 0.2, y: 0.8 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  const b = await addClaim({
    postId, sender: "2", customer: null, source: "ink", point: { x: 0.21, y: 0.79 },
    variantId: null, quantity: 2, note: "", confidence: 1, state: "pending", messageId: "",
  })

  await setSlots(postId, [
    { point: { x: 0.205, y: 0.795 }, variantId: null, size: "", claimIds: [a.id, b.id] },
  ])

  const slots = await listSlots(postId)
  assert.equal(slots.length, 1)
  assert.equal(slots[0].claimed, 3, "quantities of both claims sum into the slot")

  const claims = await listClaims(postId)
  assert.ok(claims.every((c) => c.slotId === slots[0].id))
  assert.ok(claims.every((c) => c.state === "assigned"))
})

test("re-clustering preserves what a slot already knows", async () => {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: "test/c.jpg", imageWidth: 100, imageHeight: 100,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  const first = await addClaim({
    postId, sender: "1", customer: null, source: "ink", point: { x: 0.5, y: 0.5 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  await setSlots(postId, [
    { point: { x: 0.5, y: 0.5 }, variantId: null, size: "90", claimIds: [first.id] },
  ])

  const [slot] = await listSlots(postId)
  await setSlotLabel(slot.id, "Brown Bear Set")
  await setSlotBought(slot.id, 1)

  // A later claim arrives and clustering runs again over the same position.
  const second = await addClaim({
    postId, sender: "2", customer: null, source: "ink", point: { x: 0.51, y: 0.5 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  await setSlots(postId, [
    { point: { x: 0.505, y: 0.5 }, variantId: null, size: "90", claimIds: [first.id, second.id] },
  ])

  const reclustered = await listSlots(postId)
  assert.equal(reclustered.length, 1)
  assert.equal(reclustered[0].label, "Brown Bear Set", "a name typed in the shop must survive")
  assert.equal(reclustered[0].bought, 1, "a tally made in the shop must survive re-clustering")
  assert.equal(reclustered[0].claimed, 2)
})

test("two sizes at one position are two slots that do not swap identities", async () => {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: "test/d.jpg", imageWidth: 100, imageHeight: 100,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  const small = await addClaim({
    postId, sender: "1", customer: null, source: "ink", point: { x: 0.5, y: 0.5 },
    variantId: null, quantity: 1, note: "size 90", confidence: 1, state: "pending", messageId: "",
  })
  const large = await addClaim({
    postId, sender: "2", customer: null, source: "ink", point: { x: 0.5, y: 0.5 },
    variantId: null, quantity: 1, note: "size 95", confidence: 1, state: "pending", messageId: "",
  })

  await setSlots(postId, [
    { point: { x: 0.5, y: 0.5 }, variantId: null, size: "90", claimIds: [small.id] },
    { point: { x: 0.5, y: 0.5 }, variantId: null, size: "95", claimIds: [large.id] },
  ])
  const slots = await listSlots(postId)
  assert.equal(slots.length, 2)

  const ninety = slots.find((s) => s.size === "90")
  assert.ok(ninety)
  await setSlotLabel(ninety.id, "Bear 90")

  // Re-cluster. Both slots sit on the same point, so only the size tells them
  // apart — carrying forward by position alone would put the name on either.
  await setSlots(postId, [
    { point: { x: 0.5, y: 0.5 }, variantId: null, size: "90", claimIds: [small.id] },
    { point: { x: 0.5, y: 0.5 }, variantId: null, size: "95", claimIds: [large.id] },
  ])

  const after = await listSlots(postId)
  assert.equal(after.find((s) => s.size === "90")?.label, "Bear 90")
  assert.equal(after.find((s) => s.size === "95")?.label, "")
})

test("a short buy goes to the paying customer first", async () => {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: "test/e.jpg", imageWidth: 100, imageHeight: 100,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  // No payments exist for either customer in this event, so both rank unpaid and
  // the tie-break is claim id — arrival order, which is the rule we assert here.
  const early = await addClaim({
    postId, sender: "1", customer: null, source: "ink", point: { x: 0.2, y: 0.2 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  const late = await addClaim({
    postId, sender: "2", customer: null, source: "ink", point: { x: 0.2, y: 0.2 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  await setSlots(postId, [
    { point: { x: 0.2, y: 0.2 }, variantId: null, size: "", claimIds: [early.id, late.id] },
  ])
  const [slot] = await listSlots(postId)

  await setSlotBought(slot.id, 1)

  const claims = await listClaims(postId)
  assert.equal(claims.find((c) => c.id === early.id)?.obtained, 1)
  assert.equal(claims.find((c) => c.id === late.id)?.obtained, 0)
  assert.equal((await listSlots(postId))[0].bought, 1, "the slot total is the sum of its claims")
})

test("a tick on one claim buys exactly that claim", async () => {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: "test/f.jpg", imageWidth: 100, imageHeight: 100,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  const first = await addClaim({
    postId, sender: "1", customer: null, source: "ink", point: { x: 0.3, y: 0.3 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  const second = await addClaim({
    postId, sender: "2", customer: null, source: "ink", point: { x: 0.3, y: 0.3 },
    variantId: null, quantity: 2, note: "", confidence: 1, state: "pending", messageId: "",
  })
  await setSlots(postId, [
    { point: { x: 0.3, y: 0.3 }, variantId: null, size: "", claimIds: [first.id, second.id] },
  ])

  // The owner ticked the SECOND customer's message, who asked for two.
  await markClaimObtained(second.id, 2)

  const claims = await listClaims(postId)
  assert.equal(claims.find((c) => c.id === first.id)?.obtained, 0)
  assert.equal(claims.find((c) => c.id === second.id)?.obtained, 2)
  assert.equal((await listSlots(postId))[0].bought, 2)
})
