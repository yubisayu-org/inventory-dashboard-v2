import sql from "@/lib/db-pool"
import type { DBExecutor } from "@/lib/db/actor"
import type { PricingMethod } from "@/lib/pricing"
import { getProductDefaults } from "@/lib/db/settings"
import type { WaPost } from "@/lib/db/claims"

/**
 * What a shelf is actually priced with.
 *
 * A post stores null while it is still following the WhatsApp setting, so every
 * shelf captured before the owner changed that setting picks the new one up —
 * which is the whole point of a default, and was not true while the method was
 * snapshotted at capture time.
 */
export async function effectivePricingMethod(
  post: Pick<WaPost, "pricingMethod">,
): Promise<PricingMethod> {
  if (post.pricingMethod !== null) return post.pricingMethod
  return (await getProductDefaults()).whatsappPricingMethod
}

/**
 * Stop following the setting, as of now.
 *
 * Called when the first SKU on a post is named, because that is when the method
 * stops being a preference and becomes the price on somebody's invoice. Leaving
 * the post on null past that point would mean a later settings change quietly
 * disagreeing with orders that already exist.
 *
 * Conditional on the column still being null so it can never overwrite a method
 * the owner picked by hand, and so a second naming on the same post is a no-op
 * rather than a re-freeze at a possibly different value.
 */
export async function freezePricingMethod(
  postId: number,
  method: PricingMethod,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE wa_posts SET pricing_method = ${method}, updated_at = NOW()
    WHERE id = ${postId} AND pricing_method IS NULL
  `
}
