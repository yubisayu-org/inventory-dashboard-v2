import sql from "@/lib/db-pool"
import { calcAbroadPrice } from "@/lib/pricing"
import { computeProductPrice } from "@/lib/pricing-server"
import { addProduct } from "@/lib/db/catalog"
import { appendOrders } from "@/lib/db/orders"
import { getProductDefaults } from "@/lib/db/settings"
import { getPost, listClaims, syncOrdersToClaims } from "@/lib/db/claims"
import { effectivePricingMethod, freezePricingMethod } from "./pricing-method"
import type { OrderRow } from "@/lib/db/types"

/**
 * Say what a slot is, and let everything downstream follow.
 *
 * Naming is the moment a position on a photograph becomes a product someone can
 * be invoiced for. It creates one product and one order per claim, at the
 * quantity that customer asked for.
 *
 * Three fields are typed: name, valas and gram. Store, country, event and
 * pricing method all come from the post, because the owner set them once when
 * posting and re-typing them per item would be fifteen chances to disagree.
 *
 * Price is computed by the same authority the product form uses, so a slot
 * named here and a product added by hand are priced identically.
 */
export async function nameSlot(input: {
  slotId: number
  name: string
  valas: number
  gram: number
  /** Only for target_price, whose price is an input rather than an output. */
  price?: number
  /**
   * Whether to invoice the claims at the same time. Default yes, which is the
   * usual case: the slot exists because people claimed it.
   *
   * Naming without ordering is for a rack being catalogued ahead of its
   * customers — the product exists, the prices are settled, and the orders
   * follow when it is clear who is actually taking one. addMissingOrders is
   * what creates them afterwards, and the card shows the gap in the meantime.
   */
  withOrders?: boolean
}): Promise<{ productId: number; orderCount: number }> {
  const [slotRow] = await sql`SELECT * FROM wa_slots WHERE id = ${input.slotId}`
  if (!slotRow) throw new Error(`no such slot: ${input.slotId}`)

  // Naming twice would create a second product and a second set of orders for
  // customers who already have one. Refuse rather than deduplicate, because the
  // right correction depends on why it happened.
  if (slotRow.product_id !== null) {
    throw new Error(`slot ${input.slotId} is already named`)
  }

  const post = await getPost(slotRow.post_id as number)
  if (post === null) throw new Error(`post missing for slot ${input.slotId}`)

  // Naming collects a foreign-currency price tag and a weight, and nothing else.
  // Without a country there is no rate to convert the one and no freight rate to
  // charge the other, and every method's rupiah mode instead wants a typed cost
  // that naming never asks for. Rather than price such a product at the sum of
  // its fixed fees — a plausible-looking number that is not a price — refuse.
  if (post.countryId === null) {
    throw new Error(`post ${post.id} has no country, so a valas price tag cannot be converted`)
  }

  const claims = (await listClaims(post.id)).filter(
    (c) => c.slotId === input.slotId && c.state !== "rejected",
  )

  const withOrders = input.withOrders !== false

  // A claim whose sender was never matched to a customer has nobody to invoice.
  // Blocking here keeps the failure visible; creating the product and silently
  // dropping that order would not. Only when orders are being created: naming
  // the product alone harms nobody, and the orders wait for the name anyway.
  const unresolved = withOrders ? claims.filter((c) => c.customer === null) : []
  if (unresolved.length > 0) {
    throw new Error(
      `slot ${input.slotId} has ${unresolved.length} claim(s) with an unresolved customer`,
    )
  }

  // A post that never had a method picked for it follows the WhatsApp setting,
  // and is pinned to whatever that says below — naming is where a preference
  // turns into an invoiced price.
  const pricingMethod = await effectivePricingMethod(post)

  // The one method whose price a human decides rather than a formula derives.
  // Defaulting it would invent a selling price out of nothing.
  if (pricingMethod === "target_price" && !(Number(input.price) > 0)) {
    throw new Error(`slot ${input.slotId} is on a Target Price post, which needs a price`)
  }

  const [country] = await sql`
    SELECT kurs, cargo_per_kg FROM countries WHERE id = ${post.countryId}
  `
  if (!country) throw new Error(`post ${post.id} points at a country that no longer exists`)

  const kurs = Number(country.kurs) || 0
  const cargoPerKg = Number(country.cargo_per_kg) || 0

  // The margin inputs the Add Product form pre-fills from settings. Naming has no
  // form to pre-fill, so it reads the same row the form reads.
  const defaults = await getProductDefaults()

  // Profit Margin is the one derived method the server does NOT compute: the form
  // has always sent a browser-computed price and computeProductPrice passes it
  // through. Running the same shared function here keeps the two identical
  // without changing where the authority lives.
  const overseasPrice =
    pricingMethod === "overseas"
      ? calcAbroadPrice({
          valas: input.valas,
          kurs,
          gram: input.gram,
          cargoPerKg,
          profitPct: defaults.profitPct,
          operationalFee: defaults.operationalFee,
          packingFee: defaults.packingFee,
          roundTo: defaults.profitMarginRoundTo,
        }).price
      : 0

  const body = {
    valas: input.valas,
    gram: input.gram,
    kurs,
    cargoPerKg,
    profitPct: defaults.profitPct,
    operationalFee: defaults.operationalFee,
    packingFee: defaults.packingFee,
    // Zero for every method the server prices itself, which then ignores it.
    price: pricingMethod === "target_price" ? Number(input.price) : overseasPrice,
    cost: 0,
  }

  // The catalogue spells the variant into the product name — "Grey Set M",
  // "Outer Shawl Beige" — so a sized slot carries its size there too. Skipped
  // when the owner already typed it, which they will when copying a label.
  const trimmed = input.name.trim()
  const slotSize = (slotRow.size as string) ?? ""
  const productName =
    slotSize && !trimmed.endsWith(slotSize) ? `${trimmed} ${slotSize}` : trimmed

  return sql.begin(async (tx) => {
    const priced = await computeProductPrice({
      pricingMethod,
      flatFeeMode: "fixed",
      countryId: post.countryId,
      body,
      db: tx,
    })

    const { id: productId } = await addProduct({
      name: productName,
      store: post.store,
      price: priced.price,
      gram: input.gram,
      countryId: post.countryId,
      valas: input.valas,
      kurs,
      tieredKurs: priced.tieredKurs,
      cargoPerKg,
      pricingMethod,
      flatFeeMode: "fixed",
      profitPct: defaults.profitPct,
      operationalFee: defaults.operationalFee,
      packingFee: defaults.packingFee,
      cost: priced.cost ?? 0,
      profitFixed: priced.profitFixed ?? 0,
    }, tx)

    const orders: OrderRow[] = withOrders
      ? claims.map((claim) => ({
          event: post.event,
          customer: claim.customer as string,
          productId,
          unitPrice: priced.price,
          unit: claim.quantity,
          note: claim.note,
        }))
      : []
    if (orders.length > 0) await appendOrders(orders, tx)

    await tx`
      UPDATE wa_slots SET product_id = ${productId}, updated_at = NOW()
      WHERE id = ${input.slotId}
    `

    // The owner counted in the shop hours before naming, so the slot usually
    // already knows what was bought. The same function the tally screen uses
    // carries that onto the orders just created — one road from claim to order,
    // so the two cannot drift apart depending on which end moved first.
    if (withOrders) await syncOrdersToClaims(input.slotId, tx)

    // From here the shelf has a price on somebody's invoice, so it stops
    // following the setting. In the same transaction as the product, because a
    // post frozen without its product — or priced without being frozen — is a
    // shelf whose remaining SKU could be named at a different method tomorrow.
    await freezePricingMethod(post.id, pricingMethod, tx)

    return { productId, orderCount: orders.length }
  })
}

/**
 * Which claims on a named slot have no order yet.
 *
 * Paired by customer and quantity, because appendOrders returns nothing to link
 * on: a customer with two identical lines is matched to two identical orders,
 * and only the surplus counts as missing.
 *
 * Returns nothing for a slot that was never named — there is no product to
 * order against, and the naming form is what that slot needs.
 */
export async function unorderedClaims(slotId: number): Promise<number[]> {
  const [slot] = await sql`
    SELECT s.product_id, s.post_id, p.event
    FROM wa_slots s JOIN wa_posts p ON p.id = s.post_id
    WHERE s.id = ${slotId}
  `
  if (!slot || slot.product_id === null) return []

  const claims = (await listClaims(slot.post_id as number)).filter(
    (c) => c.slotId === slotId && c.state !== "rejected" && c.customer !== null,
  )

  const existing = await sql`
    SELECT customer, unit FROM orders
    WHERE product_id = ${slot.product_id} AND event = ${slot.event}
  `
  const have = new Map<string, number>()
  for (const row of existing) {
    const key = `${row.customer}|${row.unit}`
    have.set(key, (have.get(key) ?? 0) + 1)
  }

  const missing: number[] = []
  for (const claim of claims) {
    const key = `${claim.customer}|${claim.quantity}`
    const seen = have.get(key) ?? 0
    if (seen > 0) {
      have.set(key, seen - 1)
      continue
    }
    missing.push(claim.id)
  }
  return missing
}

/**
 * Give those claims their orders, at the product the slot already became.
 *
 * A shelf is named once, and customers keep claiming afterwards: the rack is
 * still in the group, the trip is still running. Those claims land on the named
 * slot and are counted in the tally, but nameSlot refuses a second run — so
 * without this they reach no invoice at all. Visible in the shop, invisible in
 * the accounts, which is the worst way to be wrong.
 *
 * Left as a decision rather than done on arrival: this puts a line on somebody's
 * invoice, and a claim that turns out to be junk is cheaper to leave un-ordered
 * than to unpick afterwards.
 *
 * The price is the product's, not a fresh calculation: she is buying the same
 * thing as everybody else on that slot, and re-deriving it would quietly reprice
 * her if the kurs moved.
 */
export async function addMissingOrders(slotId: number): Promise<{ added: number; blocked: number }> {
  const [slot] = await sql`
    SELECT s.product_id, s.post_id, p.event
    FROM wa_slots s JOIN wa_posts p ON p.id = s.post_id
    WHERE s.id = ${slotId}
  `
  if (!slot) throw new Error(`no such slot: ${slotId}`)
  if (slot.product_id === null) throw new Error(`slot ${slotId} has not been named yet`)

  const [product] = await sql`SELECT price FROM products WHERE id = ${slot.product_id}`
  if (!product) throw new Error(`slot ${slotId} points at a product that no longer exists`)

  const claims = (await listClaims(slot.post_id as number)).filter(
    (c) => c.slotId === slotId && c.state !== "rejected",
  )
  // A claim whose sender was never matched has nobody to invoice. Counted and
  // left alone rather than blocking the rest: one unknown number should not hold
  // up three orders that are ready.
  const blocked = claims.filter((c) => c.customer === null).length

  const missing = new Set(await unorderedClaims(slotId))
  const rows: OrderRow[] = claims
    .filter((claim) => missing.has(claim.id) && claim.customer !== null)
    .map((claim) => ({
      event: slot.event as string,
      customer: claim.customer as string,
      productId: slot.product_id as number,
      unitPrice: Number(product.price) || 0,
      unit: claim.quantity,
      note: claim.note,
    }))

  if (rows.length > 0) {
    await appendOrders(rows)
    // Whatever was already counted in the shop lands on the new lines too.
    await syncOrdersToClaims(slotId)
  }

  return { added: rows.length, blocked }
}
