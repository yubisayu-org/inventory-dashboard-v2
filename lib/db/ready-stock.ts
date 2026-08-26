import postgres from "postgres"
import sql from "../db-pool"
import type { DBExecutor } from "./actor"

// Stock the shop already owns — excess_purchase, the overbuy/overship table —
// offered to customers.
//
// Two things are deliberately NOT returned: `reason` (overbuy, overship,
// wrong_product) and `receipt`. Why the shop happens to have an item, and what
// it paid, are its own business. The grant excludes both columns as well, so a
// wrong query here cannot leak them.
//
// Price is joined from products by NAME, because excess_purchase.items is free
// text with no product FK. A row whose text does not match any product has no
// price, and an unpriced item cannot be offered — see listHiddenReadyStock,
// which is what tells the shop those rows exist.

export type ReadyStockItem = {
  /** The product, not a purchase row: several rows can stock one product. */
  name: string
  /** The product this row's text matched, so a request can attach to it. */
  productId: number
  price: number
  /** In hand, orderable today. The only quantity a customer is shown. */
  readyQty: number
  /**
   * A photo for the gallery, from the newest visible catalogue post carrying
   * this product. products has no image of its own, and excess_purchase
   * certainly does not, so this is the only picture the shop already holds.
   * Null when the product has never been posted.
   */
  mediaUrl: string | null
}

const MATCHED = `
  WITH product_price AS (
    SELECT name, MIN(id) AS product_id, AVG(price) AS price
      FROM products
     GROUP BY name
  )
`

/**
 * What a customer can see: every PRODUCT that matched, priced, with units
 * actually in hand.
 *
 * One product per tile, not one purchase per tile. The shop buys the same
 * thing on several trips, and excess_purchase keeps a row for each — which
 * showed the customer "Mini Fan Beige" three times, at 5, 1 and 1, as though
 * they were three different things she had to choose between. She is buying a
 * fan, so the number she needs is how many fans there are.
 *
 * unit_arrive is what has landed; the rest of unit_buy is still shipping and
 * is not offered. A shelf that lists things on a boat asks her to decide
 * whether to wait, and the honest answer to "when" is one the shop does not
 * have — so the page only shows what could go out today.
 *
 * Filtered here rather than in the page: units on a boat are not something the
 * browser needs a copy of in order to not draw them.
 */
export async function listReadyStock(
  db: postgres.Sql | DBExecutor = sql,
): Promise<ReadyStockItem[]> {
  const rows = await db<
    {
      items: string
      product_id: number
      price: string
      ready: string
      media_url: string | null
    }[]
  >`
    WITH product_price AS (
      SELECT name, MIN(id) AS product_id, AVG(price) AS price
        FROM products
       GROUP BY name
    )
    SELECT e.items, pp.product_id, pp.price,
           -- LEAST, because unit_arrive above unit_buy is a typo, not stock.
           SUM(LEAST(COALESCE(e.unit_arrive, 0), e.unit_buy)) AS ready,
           MAX(e.created_at) AS newest,
           media.media_url
      FROM excess_purchase e
      JOIN product_price pp ON pp.name = e.items
      -- The newest visible post showing this product. LATERAL so it is one
      -- row per item rather than a fan-out to be de-duplicated afterwards.
      -- Videos are skipped: a poster frame is not something we have. The
      -- value is 'photo' — migration 058's CHECK allows ('photo','video'),
      -- and 'image' silently matches nothing.
      LEFT JOIN LATERAL (
        SELECT cp.media_url
          FROM catalogue_post_products cpp
          JOIN catalogue_posts cp ON cp.id = cpp.post_id
         WHERE cpp.product_id = pp.product_id
           AND cp.visible = true
           AND cp.media_type = 'photo'
         ORDER BY cp.created_at DESC
         LIMIT 1
      ) media ON true
     WHERE e.unit_buy > 0
       AND COALESCE(e.unit_arrive, 0) > 0
     -- product_id decides the tile; items and price come along because
     -- product_price makes them a function of it, and media_url is one row
     -- per product from the LATERAL above.
     GROUP BY pp.product_id, e.items, pp.price, media.media_url
     -- Newest arrival first, so a restock moves back to the top of the shelf.
     ORDER BY newest DESC, pp.product_id DESC
  `
  return rows.map((r) => ({
    name: r.items,
    productId: r.product_id,
    price: Math.round(Number(r.price)),
    readyQty: Number(r.ready),
    mediaUrl: r.media_url,
  }))
}

/**
 * Ready stock the customer will never see, because its text matches no
 * product and so it has no price.
 *
 * Hiding these is the right call — an unpriced item invites an order the shop
 * cannot quote — but hiding them silently is not, which is what this is for:
 * the Inventory screen says how much stock is invisible and why.
 */
export async function listHiddenReadyStock(
  db: DBExecutor = sql,
): Promise<{ id: number; name: string; qty: number }[]> {
  const rows = await db<{ id: number; items: string; unit_buy: number }[]>`
    ${sql.unsafe(MATCHED)}
    SELECT e.id, e.items, e.unit_buy
      FROM excess_purchase e
      LEFT JOIN product_price pp ON pp.name = e.items
     WHERE e.unit_buy > 0 AND pp.name IS NULL
     ORDER BY e.created_at DESC, e.id DESC
  `
  return rows.map((r) => ({ id: r.id, name: r.items, qty: r.unit_buy }))
}
