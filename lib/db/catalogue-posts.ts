import postgres from "postgres"
import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import type { CataloguePost } from "./types"

function toPost(r: Record<string, unknown>): CataloguePost {
  return {
    id: r.id as number,
    mediaUrl: r.media_url as string,
    mediaType: r.media_type as "photo" | "video",
    caption: r.caption as string,
    visible: r.visible as boolean,
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: r.updated_at ? (r.updated_at as Date).toISOString() : "",
    highlightId: (r.highlight_id as number | null) ?? null,
    productIds: (r.product_ids as number[] | null) ?? [],
  }
}

const POST_SELECT = `
  SELECT p.id, p.media_url, p.media_type, p.caption, p.visible, p.highlight_id,
         p.created_at, p.updated_at,
         COALESCE(ARRAY_AGG(pp.product_id) FILTER (WHERE pp.product_id IS NOT NULL), '{}') AS product_ids
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

export async function createCataloguePost(
  data: { mediaUrl: string; mediaType: "photo" | "video"; caption: string; productIds: number[]; highlightId?: number | null },
  db: DBExecutor = sql,
): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO catalogue_posts (media_url, media_type, caption, highlight_id)
    VALUES (${data.mediaUrl}, ${data.mediaType}, ${data.caption}, ${data.highlightId ?? null})
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
