import sql from "@/lib/db-pool"
import { calcAbroadPrice } from "@/lib/pricing"
import { computeProductPrice } from "@/lib/pricing-server"
import { addProduct } from "@/lib/db/catalog"
import { appendOrders } from "@/lib/db/orders"
import { getProductDefaults } from "@/lib/db/settings"
import { getPost, listClaims } from "@/lib/db/claims"
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

  // A claim whose sender was never matched to a customer has nobody to invoice.
  // Blocking here keeps the failure visible; creating the product and silently
  // dropping that order would not.
  const unresolved = claims.filter((c) => c.customer === null)
  if (unresolved.length > 0) {
    throw new Error(
      `slot ${input.slotId} has ${unresolved.length} claim(s) with an unresolved customer`,
    )
  }

  // The one method whose price a human decides rather than a formula derives.
  // Defaulting it would invent a selling price out of nothing.
  if (post.pricingMethod === "target_price" && !(Number(input.price) > 0)) {
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
    post.pricingMethod === "overseas"
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
    price: post.pricingMethod === "target_price" ? Number(input.price) : overseasPrice,
    cost: 0,
  }

  return sql.begin(async (tx) => {
    const priced = await computeProductPrice({
      pricingMethod: post.pricingMethod,
      flatFeeMode: "fixed",
      countryId: post.countryId,
      body,
      db: tx,
    })

    const { id: productId } = await addProduct({
      name: input.name.trim(),
      store: post.store,
      price: priced.price,
      gram: input.gram,
      countryId: post.countryId,
      valas: input.valas,
      kurs,
      tieredKurs: priced.tieredKurs,
      cargoPerKg,
      pricingMethod: post.pricingMethod,
      flatFeeMode: "fixed",
      profitPct: defaults.profitPct,
      operationalFee: defaults.operationalFee,
      packingFee: defaults.packingFee,
      cost: priced.cost ?? 0,
      profitFixed: priced.profitFixed ?? 0,
    }, tx)

    const orders: OrderRow[] = claims.map((claim) => ({
      event: post.event,
      customer: claim.customer as string,
      productId,
      unitPrice: priced.price,
      unit: claim.quantity,
      note: claim.note,
    }))
    await appendOrders(orders, tx)

    await tx`
      UPDATE wa_slots SET product_id = ${productId}, updated_at = NOW()
      WHERE id = ${input.slotId}
    `

    return { productId, orderCount: claims.length }
  })
}
