import postgres from "postgres"
import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import type { CatalogueHighlight } from "./types"

function toHighlight(r: Record<string, unknown>): CatalogueHighlight {
  return {
    id: r.id as number,
    name: r.name as string,
    defaultEvent: (r.default_event as string | null) ?? null,
    sortOrder: r.sort_order as number,
    visible: r.visible as boolean,
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: r.updated_at ? (r.updated_at as Date).toISOString() : "",
  }
}

/** Staff path: every highlight regardless of visibility, ordered for the
 *  management UI. */
export async function getCatalogueHighlights(db: DBExecutor = sql): Promise<CatalogueHighlight[]> {
  const rows = await db`
    SELECT id, name, default_event, sort_order, visible, created_at, updated_at
    FROM catalogue_highlights
    ORDER BY sort_order ASC, id ASC
  `
  return rows.map(toHighlight)
}

/** Public path: visible highlights only, id+name only (never
 *  default_event — staff-only, see migration 080's grant comment). `db`
 *  must be the scoped `catalogue_public` connection — no default. */
export async function getVisibleCatalogueHighlights(
  db: postgres.Sql,
): Promise<{ id: number; name: string }[]> {
  const rows = await db`
    SELECT id, name FROM catalogue_highlights
    WHERE visible = true
    ORDER BY sort_order ASC, id ASC
  `
  return rows.map((r) => ({ id: r.id as number, name: r.name as string }))
}

export async function createCatalogueHighlight(
  data: { name: string; defaultEvent: string | null; sortOrder: number },
  db: DBExecutor = sql,
): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO catalogue_highlights (name, default_event, sort_order)
    VALUES (${data.name}, ${data.defaultEvent}, ${data.sortOrder})
    RETURNING id
  `
  return { id: row.id as number }
}

export async function updateCatalogueHighlight(
  id: number,
  data: { name: string; defaultEvent: string | null; sortOrder: number; visible: boolean },
  db: DBExecutor = sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_highlights
    SET name = ${data.name}, default_event = ${data.defaultEvent},
        sort_order = ${data.sortOrder}, visible = ${data.visible}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Highlight not found")
}
