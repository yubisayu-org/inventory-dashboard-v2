# Catalogue Highlights (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** let the owner group catalogue posts into named highlights, each
with an optional default purchasing event, folded into the existing
Catalogue Posts page — and have that default event pre-fill the Convert
modal's event picker when converting a request that originated from a
highlighted post.

**Architecture:** one new table (`catalogue_highlights`), one new FK column
on `catalogue_posts` (`highlight_id`), one new FK column on
`catalogue_requests` (`post_id` — the missing link this whole feature
depends on, closed as part of this plan). New owner-authenticated CRUD
routes for highlights, extensions to the existing catalogue-posts routes
for assignment, new/extended public routes for the customer-facing browse
filter, and UI additions to two existing dashboard pages. No new pages.

**Tech Stack:** Next.js App Router, Postgres (`postgres.js`), existing
`EventSelect`/`SearchableSelect` components.

**Spec:** `docs/superpowers/specs/2026-08-17-catalogue-highlights-design.md`

## Global Constraints

- One highlight per post (nullable `highlight_id` column, not a join
  table) — an explicit design choice, not a placeholder for a future
  many-to-many.
- A highlight's cover is implicitly whichever assigned post has the
  earliest `created_at` — no new upload flow, no cover-image column.
- Event-prefill is a default only, never enforced — the owner can always
  override it in the Convert modal, and if any link in the chain
  (post → highlight → default_event → currently active) is missing, the
  picker falls back to blank exactly as it does today.
- `default_event` is staff-only information — never granted to
  `catalogue_public`, never returned by any public route.
- This plan does NOT touch the custom-request edit/approval feature
  (`country_id`/`valas`/`gram`/`estimated_price`/`offer_pending`/
  `approved` on `catalogue_requests`) — unrelated, already shipped.
- Out of scope for this plan: the customer-facing highlights browsing UI
  (topbar icon, picker sheet, filtered story feed) — separate plan, other
  repo (`video-catalog`).

---

### Task 1: Migration — `catalogue_highlights` table, `highlight_id`, `post_id`

**Files:**
- Create: `supabase/migrations/065_catalogue_highlights.sql`

**Interfaces:**
- Produces: `catalogue_highlights(id, name, default_event, sort_order,
  visible, created_at, updated_at)`. `catalogue_posts.highlight_id`
  (nullable FK). `catalogue_requests.post_id` (nullable FK).

- [ ] **Step 1: Write the migration**

```sql
-- Catalogue Highlights (see
-- docs/superpowers/specs/2026-08-17-catalogue-highlights-design.md).
-- Owner groups catalogue posts into named highlights, each with an
-- optional default purchasing event, so converting a request that
-- originated from a highlighted post pre-fills the event picker instead
-- of a manual pick every time. One highlight per post (nullable FK, no
-- join table) — an explicit design choice.
--
-- Also adds catalogue_requests.post_id: the missing link needed to trace
-- a request back to its originating post. The video-catalog site's "Fix"
-- flow already has this id client-side but never sent it — closing that
-- gap is part of this migration's reason for existing, not a separate
-- concern.

CREATE TABLE catalogue_highlights (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  default_event TEXT REFERENCES events(name),
  sort_order INTEGER NOT NULL DEFAULT 0,
  visible BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

ALTER TABLE catalogue_posts
  ADD COLUMN highlight_id INTEGER REFERENCES catalogue_highlights(id) ON DELETE SET NULL;

ALTER TABLE catalogue_requests
  ADD COLUMN post_id INTEGER REFERENCES catalogue_posts(id) ON DELETE SET NULL;

-- catalogue_public already has whole-table SELECT on catalogue_posts
-- (migration 059) — highlight_id is included automatically, no new grant
-- needed there. catalogue_highlights needs its own, narrower grant:
-- id/name/visible/sort_order only. NEVER default_event — that's
-- staff-only purchasing information with no reason to ever reach the
-- public site.
GRANT SELECT (id, name, visible, sort_order) ON catalogue_highlights TO catalogue_public;

-- Additive: post_id joins the existing INSERT column list (migration 061)
-- for the Fix-flow submission path. No public SELECT grant on
-- catalogue_requests.post_id — nothing on the public read path needs it
-- (only the owner-side event-prefill query, which runs as the
-- unrestricted app role, reads it).
GRANT INSERT (post_id) ON catalogue_requests TO catalogue_public;
```

- [ ] **Step 2: Apply the migration**

Per this repo's established local-dev workflow: `psql
"postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f
supabase/migrations/065_catalogue_highlights.sql`.

- [ ] **Step 3: Verify**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d catalogue_highlights"
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d catalogue_posts" | grep highlight_id
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d catalogue_requests" | grep post_id
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "SELECT grantee, privilege_type, column_name FROM information_schema.column_privileges WHERE table_name = 'catalogue_highlights' AND grantee = 'catalogue_public'"
```

Expected: `catalogue_highlights` exists with all seven columns;
`catalogue_posts.highlight_id` and `catalogue_requests.post_id` both exist
as nullable integers; `catalogue_public`'s grant on `catalogue_highlights`
lists exactly `id, name, visible, sort_order` (never `default_event`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/065_catalogue_highlights.sql
git commit -m "feat(catalogue): schema for catalogue highlights and post_id linkage"
```

---

### Task 2: Data layer — highlights CRUD, post/request extensions

**Files:**
- Create: `lib/db/catalogue-highlights.ts`
- Modify: `lib/db/catalogue-posts.ts`
- Modify: `lib/db/catalogue-requests.ts`
- Modify: `lib/db/types.ts`

**Interfaces:**
- Produces: `getCatalogueHighlights(db?): Promise<CatalogueHighlight[]>`
  (all, owner path), `getVisibleCatalogueHighlights(db): Promise<{id,
  name}[]>` (public path, requires the scoped `catalogue_public`
  connection, no default), `createCatalogueHighlight(data, db?):
  Promise<{id}>`, `updateCatalogueHighlight(id, data, db?): Promise<void>`.
  `createCataloguePost` gains an optional `highlightId`.
  `getVisibleCataloguePosts` gains an optional `highlightId` filter.
  `setCataloguePostHighlight(id, highlightId, db?): Promise<void>`.
  `createCatalogueRequest` gains an optional `postId`. `getCatalogueRequests`
  (owner path only) now also returns `postId` and `defaultEvent`.

- [ ] **Step 1: Add the `CatalogueHighlight` type and extend existing types**

In `lib/db/types.ts`, add a new interface near `CataloguePost` (find that
interface, currently ending around line 578):

```typescript
export interface CatalogueHighlight {
  id: number
  name: string
  defaultEvent: string | null
  sortOrder: number
  visible: boolean
  createdAt: string
  updatedAt: string
}
```

Extend `CataloguePost` (currently lines 568-578) to add one field:

```typescript
export interface CataloguePost {
  id: number
  mediaUrl: string
  mediaType: "photo" | "video"
  caption: string
  visible: boolean
  createdAt: string
  updatedAt: string
  highlightId: number | null
  /** Products tagged in this post. */
  productIds: number[]
}
```

Extend `CatalogueRequest` (added to by the earlier edit-approval plan —
find it, it now has `countryId`/`countryName`/`valas`/`gram`/
`estimatedPrice` fields) to add two more:

```typescript
export interface CatalogueRequest {
  // ...existing fields unchanged...
  postId: number | null
  /** Resolved from post -> highlight -> default_event, only when it
   *  currently matches an active event. Owner-read path only — the public
   *  status-lookup path never populates this (stays null), since a
   *  customer has no use for staff's purchasing-event bookkeeping. */
  defaultEvent: string | null
}
```

- [ ] **Step 2: Write `lib/db/catalogue-highlights.ts`**

```typescript
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
 *  default_event — staff-only, see migration 065's grant comment). `db`
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
```

- [ ] **Step 3: Extend `lib/db/catalogue-posts.ts`**

Replace `toPost` (currently lines 6-17) to add `highlightId`:

```typescript
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
```

Replace `POST_SELECT` (currently lines 19-25) to add `p.highlight_id`:

```typescript
const POST_SELECT = `
  SELECT p.id, p.media_url, p.media_type, p.caption, p.visible, p.highlight_id,
         p.created_at, p.updated_at,
         COALESCE(ARRAY_AGG(pp.product_id) FILTER (WHERE pp.product_id IS NOT NULL), '{}') AS product_ids
  FROM catalogue_posts p
  LEFT JOIN catalogue_post_products pp ON pp.post_id = p.id
`
```

Replace `getVisibleCataloguePosts` (currently lines 30-38) to accept an
optional highlight filter. `POST_SELECT` is a raw string built outside
`postgres.js`'s tagged-template mechanism, so the filter value must go
through `db.unsafe`'s own parameter array — never string-concatenated
directly, to avoid a SQL-injection footgun even though `highlightId` is
always a validated integer by the time it reaches here:

```typescript
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
```

Update `createCataloguePost` (currently lines 50-67) to accept an optional
`highlightId`:

```typescript
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
```

Add a new setter after `setCataloguePostVisible` (end of file):

```typescript
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
```

- [ ] **Step 4: Extend `lib/db/catalogue-requests.ts`**

Update `toRequest` to add the two new fields (find the function — it was
extended by the earlier edit-approval plan and now has `countryId`/
`countryName`/`valas`/`gram`/`estimatedPrice` mappings; add alongside
them):

```typescript
    postId: (r.post_id as number | null) ?? null,
    defaultEvent: (r.default_event as string | null) ?? null,
```

Update `createCatalogueRequest` (the public-path insert function) to
accept an optional `postId`:

```typescript
export async function createCatalogueRequest(
  data: {
    customerHandle: string
    productId: number | null
    qty: number
    note: string
    description?: string
    referenceImageUrl?: string | null
    postId?: number | null
  },
  db: postgres.Sql,
): Promise<void> {
  await db`
    INSERT INTO catalogue_requests (customer_handle, product_id, qty, note, description, reference_image_url, post_id)
    VALUES (
      ${normalizeId(data.customerHandle)},
      ${data.productId},
      ${data.qty},
      ${data.note},
      ${data.description ?? ""},
      ${data.referenceImageUrl ?? null},
      ${data.postId ?? null}
    )
  `
}
```

Update `getCatalogueRequests` (the OWNER path only — do NOT touch
`getCatalogueRequestsByHandle`, the public path, which stays exactly as
it is; a customer has no use for staff's default-event bookkeeping). Add
two more `LEFT JOIN`s and two more selected columns to both of its
branches (`onlyPending` true and false):

```typescript
export async function getCatalogueRequests(
  onlyPending: boolean,
  db: DBExecutor = sql,
): Promise<CatalogueRequest[]> {
  const rows = onlyPending
    ? await db`
        SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
               r.description, r.reference_image_url,
               r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at,
               r.country_id, c.name AS country_name, r.valas, r.gram, r.estimated_price,
               r.post_id, h.default_event
        FROM catalogue_requests r
        LEFT JOIN products p ON p.id = r.product_id
        LEFT JOIN countries c ON c.id = r.country_id
        LEFT JOIN catalogue_posts cp ON cp.id = r.post_id
        LEFT JOIN catalogue_highlights h ON h.id = cp.highlight_id
        WHERE r.status IN ('pending', 'offer_pending', 'approved')
        ORDER BY r.created_at ASC
      `
    : await db`
        SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
               r.description, r.reference_image_url,
               r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at,
               r.country_id, c.name AS country_name, r.valas, r.gram, r.estimated_price,
               r.post_id, h.default_event
        FROM catalogue_requests r
        LEFT JOIN products p ON p.id = r.product_id
        LEFT JOIN countries c ON c.id = r.country_id
        LEFT JOIN catalogue_posts cp ON cp.id = r.post_id
        LEFT JOIN catalogue_highlights h ON h.id = cp.highlight_id
        ORDER BY r.created_at DESC
      `
  return rows.map(toRequest)
}
```

Note: this deliberately does NOT filter `default_event` by whether it's
currently in `activeEvents` — that check belongs in the UI (Task 6), which
already has the live `activeEvents` list from `useSheetOptions()` and can
apply the `includes()` guard there without a second round-trip.

- [ ] **Step 5: Manual verification**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/db/catalogue-highlights.ts lib/db/catalogue-posts.ts lib/db/catalogue-requests.ts lib/db/types.ts
git commit -m "feat(catalogue): data layer for highlights, post linkage, and event-prefill resolution"
```

---

### Task 3: Owner routes — highlights CRUD, post assignment

**Files:**
- Create: `app/api/sheets/catalogue-highlights/route.ts`
- Create: `app/api/sheets/catalogue-highlights/[id]/route.ts`
- Modify: `app/api/sheets/catalogue-posts/route.ts`
- Modify: `app/api/sheets/catalogue-posts/[id]/route.ts`

**Interfaces:**
- Consumes: `getCatalogueHighlights`, `createCatalogueHighlight`,
  `updateCatalogueHighlight`, `setCataloguePostHighlight` (Task 2).
- Produces: `GET /api/sheets/catalogue-highlights` →
  `{highlights: CatalogueHighlight[]}`. `POST
  /api/sheets/catalogue-highlights` — body `{name, defaultEvent,
  sortOrder}` → `{success, id}`. `PUT
  /api/sheets/catalogue-highlights/[id]` — body `{name, defaultEvent,
  sortOrder, visible}` → `{success}`. `POST /api/sheets/catalogue-posts`
  gains optional `highlightId` in its form data. `PUT
  /api/sheets/catalogue-posts/[id]` gains optional `highlightId` in its
  JSON body, independent of the existing `visible` field. Task 5's UI
  calls all of these by these exact contracts.

- [ ] **Step 1: Write `app/api/sheets/catalogue-highlights/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getCatalogueHighlights, createCatalogueHighlight, withActor } from "@/lib/db"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const highlights = await getCatalogueHighlights()
    return NextResponse.json({ highlights }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch catalogue highlights:", err)
    return NextResponse.json({ error: "Failed to fetch catalogue highlights" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const body = await req.json()
    const name = String(body.name ?? "").trim()
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 })
    }
    const defaultEvent = body.defaultEvent ? String(body.defaultEvent) : null
    const sortOrder = Number.isInteger(body.sortOrder) ? body.sortOrder : 0

    const result = await withActor(session.user.email ?? null, (tx) =>
      createCatalogueHighlight({ name, defaultEvent, sortOrder }, tx),
    )
    return NextResponse.json({ success: true, id: result.id })
  } catch (err) {
    console.error("Failed to create catalogue highlight:", err)
    return NextResponse.json({ error: "Failed to create highlight" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Write `app/api/sheets/catalogue-highlights/[id]/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { updateCatalogueHighlight, withActor } from "@/lib/db"

type Params = { params: Promise<{ id: string }> }

export async function PUT(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    const body = await req.json()
    const name = String(body.name ?? "").trim()
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 })
    }
    const defaultEvent = body.defaultEvent ? String(body.defaultEvent) : null
    const sortOrder = Number.isInteger(body.sortOrder) ? body.sortOrder : 0
    const visible = typeof body.visible === "boolean" ? body.visible : true

    await withActor(session.user.email ?? null, (tx) =>
      updateCatalogueHighlight(id, { name, defaultEvent, sortOrder, visible }, tx),
    )
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update catalogue highlight:", err)
    return NextResponse.json({ error: "Failed to update highlight" }, { status: 500 })
  }
}
```

- [ ] **Step 3: Extend `app/api/sheets/catalogue-posts/route.ts`'s POST**

In the `POST` handler, after the existing `productIds` parsing (find
`const productIdsRaw = String(form.get("productIds") ?? "[]")` and its
following parse block), add:

```typescript
    const highlightIdRaw = form.get("highlightId")
    const highlightId =
      highlightIdRaw && String(highlightIdRaw).trim() !== "" ? Number(highlightIdRaw) : null
    if (highlightId !== null && (!Number.isInteger(highlightId) || highlightId < 1)) {
      return NextResponse.json({ error: "highlightId must be a positive integer" }, { status: 400 })
    }
```

Then update the `createCataloguePost` call to pass it through:

```typescript
      result = await withActor(session.user.email ?? null, (tx) =>
        createCataloguePost({ mediaUrl: url, mediaType, caption, productIds, highlightId }, tx),
      )
```

- [ ] **Step 4: Extend `app/api/sheets/catalogue-posts/[id]/route.ts`'s PUT**

The current handler only accepts `{visible: boolean}`. Extend it to
independently accept an optional `highlightId` in the same body (either
field may be present; each triggers its own update, not mutually
exclusive — the two controls in Task 5's UI are separate, but nothing
stops a future caller from sending both):

```typescript
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { setCataloguePostVisible, setCataloguePostHighlight } from "@/lib/db"

type Params = { params: Promise<{ id: string }> }

export async function PUT(req: NextRequest, { params }: Params) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  try {
    const body = await req.json()
    if (body.visible === undefined && body.highlightId === undefined) {
      return NextResponse.json({ error: "visible or highlightId is required" }, { status: 400 })
    }
    if (body.visible !== undefined) {
      if (typeof body.visible !== "boolean") {
        return NextResponse.json({ error: "visible must be a boolean" }, { status: 400 })
      }
      await setCataloguePostVisible(id, body.visible)
    }
    if (body.highlightId !== undefined) {
      if (body.highlightId !== null && !Number.isInteger(body.highlightId)) {
        return NextResponse.json({ error: "highlightId must be an integer or null" }, { status: 400 })
      }
      await setCataloguePostHighlight(id, body.highlightId)
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update catalogue post:", err)
    return NextResponse.json({ error: "Failed to update post" }, { status: 500 })
  }
}
```

- [ ] **Step 5: Manual verification**

```bash
npx tsc --noEmit
```

With a session cookie unavailable in this environment (same established
constraint as the edit-approval plan — no dev-login bypass, never read
`.env*` to fabricate one), verify two ways: confirm each new/changed route
401s with no session (`curl -s -o /dev/null -w "%{http_code}\n"` against
each), and exercise the actual data-layer functions directly via a
throwaway script against the real local dev DB (same substitute technique
used throughout the earlier plan) — create a highlight, update it, assign
it to a real post, confirm via a raw `SELECT`. Delete the throwaway script
when done.

- [ ] **Step 6: Commit**

```bash
git add app/api/sheets/catalogue-highlights app/api/sheets/catalogue-posts
git commit -m "feat(catalogue): owner routes for highlights CRUD and post assignment"
```

---

### Task 4: Public routes — highlights list, post filter, Fix-flow postId

**Files:**
- Create: `app/api/public/catalogue/highlights/route.ts`
- Modify: `app/api/public/catalogue/route.ts`
- Modify: `app/api/public/catalogue/requests/route.ts`

**Interfaces:**
- Consumes: `getVisibleCatalogueHighlights` (Task 2).
- Produces: `GET /api/public/catalogue/highlights` → `{highlights: [{id,
  name}]}`. `GET /api/public/catalogue` gains an optional `?highlightId=`
  query param. `POST /api/public/catalogue/requests` (the Fix-flow submit
  endpoint) gains an optional `postId` in its body. The video-catalog
  frontend plan (separate, other repo) is the consumer of all three.

- [ ] **Step 1: Write `app/api/public/catalogue/highlights/route.ts`**

Mirror the existing `app/api/public/catalogue/countries/route.ts` shape
exactly (same CORS/OPTIONS/cache-header pattern — read that file first for
the precise boilerplate to copy):

```typescript
import { NextResponse } from "next/server"
import { getVisibleCatalogueHighlights } from "@/lib/db"
import catalogueSql from "@/lib/db-catalogue-public"

// TODO: swap for the real domain once the catalogue site is deployed.
const ALLOWED_ORIGIN = "https://yubisayu-catalogue.netlify.app"

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function GET() {
  try {
    const highlights = await getVisibleCatalogueHighlights(catalogueSql)
    return NextResponse.json(
      { highlights },
      { headers: { ...corsHeaders(), "Cache-Control": "public, max-age=60" } },
    )
  } catch (err) {
    console.error("Failed to fetch catalogue highlights:", err)
    return NextResponse.json(
      { error: "Failed to fetch highlights" },
      { status: 500, headers: corsHeaders() },
    )
  }
}
```

- [ ] **Step 2: Extend `app/api/public/catalogue/route.ts`'s GET**

Read the query param and pass it through to `getVisibleCataloguePosts`:

```typescript
export async function GET(req: NextRequest) {
  const highlightIdRaw = req.nextUrl.searchParams.get("highlightId")
  let highlightId: number | undefined
  if (highlightIdRaw) {
    highlightId = Number(highlightIdRaw)
    if (!Number.isInteger(highlightId) || highlightId < 1) {
      return NextResponse.json({ error: "highlightId must be a positive integer" }, { status: 400, headers: corsHeaders() })
    }
  }

  try {
    const posts = await getVisibleCataloguePosts(catalogueSql, highlightId)
    // ...rest of the existing handler body (productIds collection, batch
    // product query, attaching products per post, response) is unchanged —
    // read the current file first, this only changes how `posts` itself
    // is fetched, not anything downstream of it.
```

(Note: the file needs `NextRequest` imported if it currently only imports
`NextResponse` for a param-less `GET()` — check and add if missing.)

- [ ] **Step 3: Extend `app/api/public/catalogue/requests/route.ts`'s POST**

In the existing Fix-flow POST handler, add optional `postId` parsing
alongside the existing `productId`/`qty`/`note` validation, and pass it
through:

```typescript
    const postIdRaw = b.postId
    let postId: number | null = null
    if (postIdRaw !== undefined && postIdRaw !== null) {
      postId = Number(postIdRaw)
      if (!Number.isInteger(postId) || postId < 1) {
        return NextResponse.json({ error: "postId must be a positive integer" }, { status: 400, headers: corsHeaders() })
      }
    }
```

Then update the `createCatalogueRequest` call to include it:

```typescript
    await createCatalogueRequest({ customerHandle, productId, qty, note, postId }, catalogueSql)
```

(Match this against the actual current variable names in the file before
editing — read it first. `postId` is optional and defaults to `null` if
omitted, so this is backward-compatible with any caller that doesn't send
it yet.)

- [ ] **Step 4: Manual verification**

```bash
curl -s "http://localhost:3001/api/public/catalogue/highlights" | python3 -m json.tool
```

Expected: `{"highlights": [...]}"` (empty array is fine if none created
yet — create one via Task 3's verification first if you want a non-empty
check).

```bash
curl -s "http://localhost:3001/api/public/catalogue?highlightId=<a real highlight id with a post assigned>" | python3 -m json.tool
```

Expected: `{"posts": [...]}` containing only posts assigned to that
highlight. Compare against `curl -s "http://localhost:3001/api/public/catalogue"`
(no filter) to confirm the filtered list is a strict subset.

```bash
curl -s -X POST "http://localhost:3001/api/public/catalogue/requests" \
  -H "Content-Type: application/json" \
  -d '{"customerHandle":"test_post_id_verify","productId":<a real active product id>,"qty":1,"note":"","postId":<a real post id>}'
```

Expected: `{"success":true}`. Confirm via a direct DB read
(`SELECT post_id FROM catalogue_requests WHERE customer_handle =
'test_post_id_verify'`) that `post_id` was actually persisted. Clean up
the test row afterward.

- [ ] **Step 5: Commit**

```bash
git add app/api/public/catalogue/highlights app/api/public/catalogue/route.ts app/api/public/catalogue/requests/route.ts
git commit -m "feat(catalogue): public highlights list, post filter, and Fix-flow postId"
```

---

### Task 5: Owner UI — highlight management + per-post assignment

**Files:**
- Modify: `app/dashboard/catalogue-posts/CataloguePostsClient.tsx`

**Interfaces:**
- Consumes: `GET/POST /api/sheets/catalogue-highlights`, `PUT
  /api/sheets/catalogue-highlights/[id]` (Task 3), `PUT
  /api/sheets/catalogue-posts/[id]` with `{highlightId}` (Task 3),
  `options.activeEvents` from the existing `useSheetOptions()` hook (for
  the default-event picker).
- Produces: no later task in this plan depends on this one.

- [ ] **Step 1: Fetch highlights alongside posts**

Add state and a load function near the existing `posts`/`loading`/`error`
state (top of the component):

```typescript
  const [highlights, setHighlights] = useState<CatalogueHighlight[]>([])

  async function reloadHighlights() {
    try {
      const res = await fetch("/api/sheets/catalogue-highlights", { cache: "no-store" })
      const data = await res.json()
      setHighlights(data.highlights ?? [])
    } catch {
      // Highlights are a management convenience — a failed load shouldn't
      // block the rest of the page (posts still load/render normally).
    }
  }
```

Call `reloadHighlights()` in the existing initial-load `useEffect`
alongside whatever already loads `posts` (find that effect, add the call
there rather than a second separate effect, so both fire together on
mount).

Import `CatalogueHighlight` from `@/lib/db` alongside the existing
`CataloguePost` import.

- [ ] **Step 2: Render the highlight chips row + create/edit modal**

Above the existing posts list rendering, add a chips row:

```tsx
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <span className="text-xs font-medium text-gray-500">Highlights</span>
        {highlights.map((h) => (
          <button
            key={h.id}
            onClick={() => setEditingHighlight(h)}
            className={`px-2.5 py-1 rounded-full text-xs border ${h.visible ? "border-cream-border" : "border-gray-200 text-gray-400"}`}
          >
            {h.name} ✎
          </button>
        ))}
        <button
          onClick={() => setEditingHighlight({ id: 0, name: "", defaultEvent: null, sortOrder: 0, visible: true, createdAt: "", updatedAt: "" })}
          className="px-2.5 py-1 rounded-full text-xs border border-dashed border-cream-border text-gray-500"
        >
          + New
        </button>
      </div>
```

Add state: `const [editingHighlight, setEditingHighlight] =
useState<CatalogueHighlight | null>(null)`. `id === 0` signals "creating
new" to the modal below (a plain sentinel, matching this component's
existing style of using nullable/sentinel state rather than a separate
"mode" flag — check the file's existing conventions and adjust if it
prefers an explicit discriminator).

Add the modal component (new function in this file, alongside the
existing `UploadForm`):

```tsx
function HighlightModal({ highlight, activeEvents, onClose, onSaved }: {
  highlight: CatalogueHighlight
  activeEvents: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const isNew = highlight.id === 0
  const [name, setName] = useState(highlight.name)
  const [defaultEvent, setDefaultEvent] = useState(highlight.defaultEvent ?? "")
  const [sortOrder, setSortOrder] = useState(String(highlight.sortOrder))
  const [visible, setVisible] = useState(highlight.visible)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  async function submit() {
    if (!name.trim()) { setError("Name is required"); return }
    setSubmitting(true); setError("")
    try {
      const body = {
        name: name.trim(),
        defaultEvent: defaultEvent || null,
        sortOrder: Number(sortOrder) || 0,
        visible,
      }
      const res = isNew
        ? await fetch("/api/sheets/catalogue-highlights", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await fetch(`/api/sheets/catalogue-highlights/${highlight.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl p-5 w-full max-w-sm flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-foreground">{isNew ? "New highlight" : "Edit highlight"}</h3>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Highlight name"
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
        />
        <EventSelect value={defaultEvent} onChange={setDefaultEvent} events={activeEvents} placeholder="Default event (optional)…" clearable />
        <input
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
          placeholder="Sort order"
          type="number"
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
        />
        {!isNew && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
            Visible to customers
          </label>
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}
```

Import `EventSelect` from `@/components/EventSelect` (already used
elsewhere in this codebase — check whether it's already imported in this
file; if not, add the import).

Render the modal conditionally near the component's other modal renders
(or at the end of the JSX if this file has no other modals yet — check):

```tsx
      {editingHighlight && (
        <HighlightModal
          highlight={editingHighlight}
          activeEvents={options?.activeEvents ?? []}
          onClose={() => setEditingHighlight(null)}
          onSaved={() => { setEditingHighlight(null); reloadHighlights() }}
        />
      )}
```

- [ ] **Step 3: Add a per-post highlight-assignment dropdown**

In the existing post row rendering (find the row markup, currently just
thumbnail + caption + tagged-count + visible toggle), add a `select`
between the caption/count text and the visible toggle button:

```tsx
              <select
                value={post.highlightId ?? ""}
                onChange={(e) => assignHighlight(post, e.target.value ? Number(e.target.value) : null)}
                className="text-xs border border-cream-border rounded-lg px-1.5 py-1"
              >
                <option value="">No highlight</option>
                {highlights.map((h) => (
                  <option key={h.id} value={h.id}>{h.name}</option>
                ))}
              </select>
```

Add the handler near the existing `toggleVisible` function, following its
exact optimistic-update-with-rollback shape:

```typescript
  async function assignHighlight(post: CataloguePost, highlightId: number | null) {
    const prev = posts
    setPosts((p) => p.map((x) => (x.id === post.id ? { ...x, highlightId } : x)))
    try {
      const res = await fetch(`/api/sheets/catalogue-posts/${post.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ highlightId }),
      })
      if (!res.ok) throw new Error()
    } catch {
      setPosts(prev)
      setError("Failed to update highlight")
    }
  }
```

(Match this exactly against `toggleVisible`'s actual current shape in the
file — read it first, this should mirror its structure, not diverge from
it.)

- [ ] **Step 4: Add a highlight picker to the post-creation form**

In `UploadForm`, add a highlight `<select>` near the existing
caption/product-checkbox fields, local state
`const [highlightId, setHighlightId] = useState<string>("")`, and include
it in the `FormData` built by `submit()`:

```typescript
    if (highlightId) formData.append("highlightId", highlightId)
```

(Match the exact `FormData` construction already present in `submit()` —
read it first, this is one more `.append()` call alongside the existing
`file`/`caption`/`productIds` ones.) `UploadForm` needs a new
`highlights: CatalogueHighlight[]` prop, passed from the parent alongside
its existing `options` prop.

- [ ] **Step 5: Manual verification**

`npx tsc --noEmit` clean. Same auth-unavailable constraint as prior
tasks — verify via direct data-layer/DB checks rather than a live
authenticated click-through (create a highlight via the API directly with
a throwaway script mimicking what the UI would send, confirm it round-trips
through `getCatalogueHighlights`; assign a post to it via
`setCataloguePostHighlight` directly, confirm via
`getVisibleCataloguePosts(db, highlightId)` that filtering works).

- [ ] **Step 6: Commit**

```bash
git add app/dashboard/catalogue-posts/CataloguePostsClient.tsx
git commit -m "feat(catalogue): owner UI for highlight management and post assignment"
```

---

### Task 6: Owner UI — event-prefill in the Convert modal

**Files:**
- Modify: `app/dashboard/order-requests/OrderRequestsClient.tsx`

**Interfaces:**
- Consumes: `CatalogueRequest.defaultEvent` (Task 2), already-available
  `options.activeEvents` (existing `useSheetOptions()` hook, already used
  by this component).
- Produces: no later task depends on this one.

- [ ] **Step 1: Pass the resolved default event into `ConvertModal`**

At the call site (find `{converting && <ConvertModal ... />}`), add one
more prop:

```tsx
        <ConvertModal
          requestId={converting.id}
          needsProduct={converting.productId === null}
          events={options?.activeEvents ?? []}
          items={options?.items ?? []}
          defaultEvent={converting.defaultEvent}
          onClose={() => setConvertingId(null)}
          onDone={() => { setConvertingId(null); reload() }}
        />
```

- [ ] **Step 2: Seed `ConvertModal`'s event state from it**

Add `defaultEvent: string | null` to `ConvertModal`'s prop type, and
change the `event` state's initialization from a plain `useState("")` to
a lazy initializer that only uses the default if it's actually in the
live `events` list (the fallback case per the spec — a deactivated or
otherwise-missing default event must not silently prefill):

```tsx
function ConvertModal({ requestId, needsProduct, events, items, defaultEvent, onClose, onDone }: {
  requestId: number
  needsProduct: boolean
  events: string[]
  items: { id: number; name: string; store: string; price: number; active: boolean }[]
  defaultEvent: string | null
  onClose: () => void
  onDone: () => void
}) {
  const [event, setEvent] = useState(() => (defaultEvent && events.includes(defaultEvent)) ? defaultEvent : "")
  // ...rest of the function unchanged...
```

The owner can still freely change the picker — this only changes the
initial value, nothing else about the modal's behavior.

- [ ] **Step 3: Manual verification**

`npx tsc --noEmit` clean. Behavioral verification: create a highlight
with a `default_event` set to a real active event name, assign a real
post to it, create a Fix request tagged to that post with `postId` set
(via Task 4's verified public route), confirm via
`getCatalogueRequests(true)` (direct data-layer call, same substitute
technique as before) that the resulting `CatalogueRequest` row's
`defaultEvent` field resolves correctly. Full UI click-through (does the
picker actually show pre-selected) is deferred to a real authenticated
session per this plan's established auth constraint — note this
explicitly in your report rather than claiming it was visually confirmed.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/order-requests/OrderRequestsClient.tsx
git commit -m "feat(catalogue): pre-fill Convert modal's event from the request's highlight"
```

---

### Task 7: End-to-end verification

No automated test suite exists — full manual pass against the local dev
DB and running dev server, using the substitute-verification techniques
established throughout this plan (no owner session available in this
environment).

**Files:** none (verification only)

- [ ] **Step 1: Confirm the dev server and local Supabase are up**

`curl -s -o /dev/null -w "%{http_code}" http://localhost:3001` (expect
307).

- [ ] **Step 2: Full highlight lifecycle**

Create a highlight (direct data-layer call or via the owner route,
whichever you verified in Task 3), assign two real posts to it, confirm
`GET /api/public/catalogue/highlights` lists it and `GET
/api/public/catalogue?highlightId=<id>` returns exactly those two posts.
Edit the highlight's `default_event` and `visible` fields, confirm both
persist. Set `visible = false`, confirm it disappears from the public
highlights list but the assigned posts are unaffected (still visible in
the unfiltered public feed if their own `visible` flag is true — a
highlight's visibility only gates the highlight-browsing UI, not the
posts themselves; this is implicit in the design, confirm it holds in the
actual query logic).

- [ ] **Step 3: Full event-prefill chain**

Submit a real Fix request against a highlighted post's tagged product
(via the public requests route with `postId` set), confirm the resulting
request's `defaultEvent` resolves correctly through the owner-side query.
Then submit a Fix request against an UN-highlighted post (or with no
`postId` at all), confirm `defaultEvent` is `null` — the fallback path
must not error or return a stale value.

- [ ] **Step 4: Confirm the plumbing fix didn't break anything upstream**

Confirm a request created with no `postId` at all (simulating a client
that hasn't been updated yet — the video-catalog frontend plan for this
feature hasn't shipped when this backend plan lands) still round-trips
correctly through every existing read path — the `postId`/`defaultEvent`
fields should just be `null`, nothing should throw.

- [ ] **Step 5: Final commit (if any fixes were needed)**

If any step required a code fix, commit it individually with a clear
message. If everything passed as-built, nothing to commit.

---

## Self-Review

**1. Spec coverage:** Data model (Task 1), data layer for both highlights
and the post_id linkage (Task 2), owner routes (Task 3), public routes
including the Fix-flow plumbing fix (Task 4), owner UI for management
(Task 5) and event-prefill (Task 6) — every section of the spec covered
for this repo's half of the feature. The customer-facing browsing UI
(topbar icon, picker sheet, filtered story feed) is explicitly out of
scope per this plan's Global Constraints — separate plan, other repo.

**2. Placeholder scan:** No "TBD"/"TODO" introduced by this plan (the one
`TODO` in Task 4's new route is copied verbatim from every other public
catalogue route's real, pre-existing domain-swap TODO).

**3. Type consistency:** `CatalogueHighlight`'s fields (Task 2) match
exactly across `toHighlight`, `getCatalogueHighlights`,
`getVisibleCatalogueHighlights` (subset), `createCatalogueHighlight`,
`updateCatalogueHighlight`, and Task 5's UI usage (`highlight.name`,
`highlight.defaultEvent`, etc.). `CataloguePost.highlightId` is consistent
across `toPost`, `POST_SELECT`, `createCataloguePost`,
`setCataloguePostHighlight`, and Task 5's dropdown. `CatalogueRequest.postId`/
`.defaultEvent` are consistent across `toRequest`, `createCatalogueRequest`,
`getCatalogueRequests`, and Task 6's `ConvertModal` usage.
`getVisibleCataloguePosts`'s new `highlightId?: number` parameter is used
identically by Task 4's route.

**4. Scope check:** One cohesive backend addition — schema, data layer,
four route surfaces, two UI touch-points. The customer-facing half is a
separate plan by design (matching this whole feature family's established
two-plan convention), and this backend's contracts must be real and
verified before that frontend plan is written.
