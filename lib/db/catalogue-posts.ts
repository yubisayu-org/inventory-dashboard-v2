import postgres from "postgres"
import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import type { CataloguePost } from "./types"

function toPost(r: Record<string, unknown>): CataloguePost {
  return {
    id: r.id as number,
    mediaUrl: r.media_url as string,
    mediaType: r.media_type as "photo" | "video",
    title: r.title as string,
    visible: r.visible as boolean,
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: r.updated_at ? (r.updated_at as Date).toISOString() : "",
    highlightId: (r.highlight_id as number | null) ?? null,
    productIds: (r.product_ids as number[] | null) ?? [],
    everSent: r.ever_sent as boolean,
    pinnedCount: Number(r.pinned_count ?? 0),
  }
}

const POST_SELECT = `
  SELECT p.id, p.media_url, p.media_type, p.title, p.visible, p.highlight_id,
         p.created_at, p.updated_at,
         COALESCE(ARRAY_AGG(pp.product_id) FILTER (WHERE pp.product_id IS NOT NULL), '{}') AS product_ids,
         EXISTS (SELECT 1 FROM wa_sends s WHERE s.post_id = p.id AND s.message_id <> '') AS ever_sent,
         (
           SELECT COUNT(DISTINCT pp2.product_id)
           FROM catalogue_post_products pp2
           WHERE pp2.post_id = p.id
             AND EXISTS (
               SELECT 1 FROM wa_send_codes c
               JOIN wa_sends s2 ON s2.id = c.send_id
               WHERE s2.post_id = p.id AND c.product_id = pp2.product_id
                 AND c.point_x IS NOT NULL AND c.point_y IS NOT NULL
             )
         ) AS pinned_count
  FROM catalogue_posts p
  LEFT JOIN catalogue_post_products pp ON pp.post_id = p.id
`

/** Public path: only posts staff has marked visible, optionally filtered
 *  to one highlight. `db` must be the scoped `catalogue_public` connection
 *  (lib/db-catalogue-public.ts) — no default, so a caller can't
 *  accidentally use the main pool here. `POST_SELECT` is a raw string
 *  built outside postgres.js's tagged-template mechanism, so the filter
 *  value must go through `db.unsafe`'s own parameter array — never
 *  string-concatenated directly, to avoid a SQL-injection footgun even
 *  though `highlightId` is always a validated integer by the time it
 *  reaches here. */
export async function getVisibleCataloguePosts(
  db: postgres.Sql,
  highlightId?: number,
): Promise<CataloguePost[]> {
  const highlightFilter = highlightId != null ? "AND p.highlight_id = $1" : ""
  const rows = await db.unsafe(
    `
      ${POST_SELECT}
      WHERE p.visible = true
      ${highlightFilter}
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `,
    highlightId != null ? [highlightId] : [],
  )
  return rows.map(toPost)
}

/** Staff path: every post regardless of visibility. */
export async function getAllCataloguePosts(db: DBExecutor = sql): Promise<CataloguePost[]> {
  const rows = await db.unsafe(`
    ${POST_SELECT}
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `)
  return rows.map(toPost)
}

/** Staff path: one post by id, including its tagged `catalogue_post_products`
 *  (`productIds`) — the composer's "Pakai post lama" pre-fill reads this to
 *  learn which products a past post was tagged with. */
export async function getCataloguePost(id: number, db: DBExecutor = sql): Promise<CataloguePost | null> {
  const rows = await db.unsafe(
    `
      ${POST_SELECT}
      WHERE p.id = $1
      GROUP BY p.id
    `,
    [id],
  )
  return rows.length > 0 ? toPost(rows[0]) : null
}

/**
 * Split a post's tagged products into what's still sellable and what's
 * been delisted since — a repost's pre-fill uses this to auto-attach only
 * the still-active ones, and to name the rest instead of either silently
 * re-advertising a delisted product or silently dropping it with no trace.
 */
export async function splitProductsByActive(
  productIds: number[],
  db: DBExecutor = sql,
): Promise<{ activeIds: number[]; removed: { id: number; name: string }[] }> {
  if (productIds.length === 0) return { activeIds: [], removed: [] }
  const rows = await db`
    SELECT id, name, is_active FROM products WHERE id = ANY(${productIds})
  `
  const activeIds: number[] = []
  const removed: { id: number; name: string }[] = []
  for (const row of rows) {
    if (row.is_active) activeIds.push(row.id as number)
    else removed.push({ id: row.id as number, name: row.name as string })
  }
  return { activeIds, removed }
}

export async function createCataloguePost(
  data: { mediaUrl: string; mediaType: "photo" | "video"; title: string; productIds: number[]; highlightId?: number | null },
  db: DBExecutor = sql,
): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO catalogue_posts (media_url, media_type, title, highlight_id)
    VALUES (${data.mediaUrl}, ${data.mediaType}, ${data.title}, ${data.highlightId ?? null})
    RETURNING id
  `
  const id = row.id as number
  if (data.productIds.length > 0) {
    await db`
      INSERT INTO catalogue_post_products (post_id, product_id)
      VALUES ${db(data.productIds.map((pid) => [id, pid]))}
    `
  }
  return { id }
}

export async function setCataloguePostVisible(
  id: number,
  visible: boolean,
  db: DBExecutor = sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_posts SET visible = ${visible}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Catalogue post not found")
}

/**
 * Replace which products a post is tagged with — the fix for a post whose
 * tags have all gone inactive since (quick-resend's "No active products to
 * send" has no other way to resolve). A full replace, not a diff: the
 * caller always sends the complete new set, same as createCataloguePost.
 */
export async function setCataloguePostProducts(
  id: number,
  productIds: number[],
): Promise<void> {
  await sql.begin(async (tx) => {
    const [post] = await tx`SELECT id FROM catalogue_posts WHERE id = ${id}`
    if (!post) throw new Error("Catalogue post not found")
    await tx`DELETE FROM catalogue_post_products WHERE post_id = ${id}`
    if (productIds.length > 0) {
      await tx`
        INSERT INTO catalogue_post_products (post_id, product_id)
        VALUES ${tx(productIds.map((pid) => [id, pid]))}
      `
    }
    await tx`UPDATE catalogue_posts SET updated_at = NOW() WHERE id = ${id}`
  })
}

export async function setCataloguePostTitle(
  id: number,
  title: string,
  db: DBExecutor = sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_posts SET title = ${title}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Catalogue post not found")
}

/**
 * Delete a post. Sends that actually went out keep their record — a code a
 * customer could have ordered against must never be reissued to a different
 * product — so those rows are detached (post_id → NULL, migration 087)
 * rather than deleted, which preserves their wa_send_codes intact. Sends
 * that never went out carry no such risk and are hard-deleted, freeing
 * their codes for reuse (matches nextCode()'s max-scan behavior).
 *
 * Returns the post's media_url so the caller can also remove the file from
 * Storage, or null if the post didn't exist.
 */
export async function deleteCataloguePost(id: number): Promise<{ mediaUrl: string } | null> {
  return sql.begin(async (tx) => {
    const [post] = await tx`SELECT media_url FROM catalogue_posts WHERE id = ${id}`
    if (!post) return null
    await tx`UPDATE wa_sends SET post_id = NULL WHERE post_id = ${id} AND message_id <> ''`
    await tx`DELETE FROM wa_sends WHERE post_id = ${id} AND message_id = ''`
    await tx`DELETE FROM catalogue_posts WHERE id = ${id}`
    return { mediaUrl: post.media_url as string }
  })
}

export async function setCataloguePostHighlight(
  id: number,
  highlightId: number | null,
  db: DBExecutor = sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_posts SET highlight_id = ${highlightId}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Catalogue post not found")
}
