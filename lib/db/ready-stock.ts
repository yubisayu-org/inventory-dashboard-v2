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
  id: number
  name: string
  /** The product this row's text matched, so a request can attach to it. */
  productId: number
  price: number
  /** In hand, orderable today. */
  readyQty: number
  /** Bought and on its way. */
  transitQty: number
}

const MATCHED = `
  WITH product_price AS (
    SELECT name, MIN(id) AS product_id, AVG(price) AS price
      FROM products
     GROUP BY name
  )
`

/**
 * What a customer can see: every row that matched a product and still has
 * units, priced.
 *
 * unit_arrive is what has landed; the rest of unit_buy is still shipping. Both
 * are shown, labelled, rather than hiding what is coming — a customer deciding
 * whether to wait needs to know it exists.
 */
export async function listReadyStock(
  db: postgres.Sql | DBExecutor = sql,
): Promise<ReadyStockItem[]> {
  const rows = await db<
    {
      id: number
      items: string
      product_id: number
      price: string
      unit_buy: number
      unit_arrive: number | null
    }[]
  >`
    WITH product_price AS (
      SELECT name, MIN(id) AS product_id, AVG(price) AS price
        FROM products
       GROUP BY name
    )
    SELECT e.id, e.items, pp.product_id, pp.price, e.unit_buy, e.unit_arrive
      FROM excess_purchase e
      JOIN product_price pp ON pp.name = e.items
     WHERE e.unit_buy > 0
     ORDER BY e.created_at DESC, e.id DESC
  `
  return rows.map((r) => {
    const arrived = Math.min(r.unit_arrive ?? 0, r.unit_buy)
    return {
      id: r.id,
      name: r.items,
      productId: r.product_id,
      price: Math.round(Number(r.price)),
      readyQty: arrived,
      transitQty: r.unit_buy - arrived,
    }
  })
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
