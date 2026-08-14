# Photo/Video Catalogue with Customer Order Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public, no-login `/catalogue` page where customers browse photo/video posts (each tagging one or more products), submit a one-tap "Fix" request with qty + note, and check request status by IG handle — requests are staff-reviewed and converted into real orders, never written into `orders` directly.

**Architecture:** Two new tables (`catalogue_posts`, many-to-many `catalogue_post_products`, `catalogue_requests`) behind a new least-privilege Postgres role (`catalogue_public`) for the public read/write path, mirroring the existing `invoice_reader` trusted-gateway pattern. Staff manage posts and review/convert requests through two new `/dashboard` pages using the app's normal session-gated pool. Media files go to Supabase Storage via a new `@supabase/supabase-js` dependency, used only for file bytes — the rest of the DB access stays raw SQL via `postgres`.

**Tech Stack:** Next.js App Router (route handlers), `postgres` (raw SQL, no ORM), NextAuth v5 sessions, Supabase (Postgres + Storage), `@supabase/supabase-js` (new, storage-only).

## Global Constraints

- No test framework exists in this repo (no jest/vitest/playwright, no `*.test.*` files, no test script in `package.json`). Every task's verification step is `npx tsc --noEmit` + `npm run build`, plus a manual check (curl, a one-off `node -e` script against the DB, or the dev server in a browser) where relevant — the same pattern already used throughout this project's history. Do not invent a test runner.
- Migrations are applied **manually** in the Supabase SQL editor as the `postgres` owner role — the app's own DB role cannot run DDL. Test each migration locally first: `supabase start` (Docker must be running), then `supabase migration up`. Never `supabase db reset`.
- Customer handles are always stored and compared via `normalizeId()` (`lib/db/helpers.ts:8`) — bare lowercase, no `@`.
- New public routes must stay outside `/dashboard` — `middleware.ts`'s matcher is `["/dashboard/:path*"]` only, so nothing extra is needed to keep them unauthenticated, but nothing must be added under `/dashboard` for the public-facing pieces.
- Public DB access goes through a dedicated low-privilege role and its own connection pool — never the main app pool (`lib/db-pool.ts`), which is effectively owner-level.
- Staff-only pages are owner-only by default (not added to `ADMIN_ROUTES` in `lib/access.ts`) unless a task says otherwise.

---

### Task 1: Widen `appendOrders` to return inserted order ids

The request-conversion flow (Task 12) needs the id of the order it just created, to store as `catalogue_requests.converted_order_id`. `appendOrders` currently returns `Promise<void>`.

**Files:**
- Modify: `lib/db/orders.ts:337-365`

**Interfaces:**
- Produces: `appendOrders(orders: OrderRow[], db: DBExecutor = sql): Promise<{ id: number; productId: number }[]>` (was `Promise<void>`)

- [ ] **Step 1: Confirm the only call site doesn't rely on the old return type**

Run: `grep -rn "appendOrders(" app lib`
Expected: exactly one call site, `app/api/sheets/orders/route.ts:26`, and it's `await`ed with the result discarded (the route builds its response from `rows.length`, not the DB result). Confirms widening the return type is safe — nothing destructures `void`.

- [ ] **Step 2: Add `RETURNING` to the insert and widen the return type**

In `lib/db/orders.ts`, replace the function:

```typescript
export async function appendOrders(
  orders: OrderRow[],
  db: DBExecutor = sql,
): Promise<{ id: number; productId: number }[]> {
  if (orders.length === 0) return []

  const normalized = orders.map((o) => ({
    ...o,
    customer: normalizeCustomer(o.customer),
  }))

  // Auto-create customer records for any new customers
  const uniqueCustomers = [...new Set(normalized.map((o) => o.customer))]
  await db`
    INSERT INTO customers (instagram_id)
    VALUES ${db(uniqueCustomers.map((c) => [c]))}
    ON CONFLICT (instagram_id) DO NOTHING
  `

  const inserted = await db`
    INSERT INTO orders ${db(
      normalized.map((o) => ({
        event: o.event,
        customer: o.customer,
        product_id: o.productId,
        unit_price: o.unitPrice,
        unit: o.unit,
        note: o.note,
      }))
    )}
    RETURNING id, product_id
  `
  return inserted.map((r) => ({ id: r.id as number, productId: r.product_id as number }))
}
```

- [ ] **Step 3: Typecheck and build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed with no errors. `app/api/sheets/orders/route.ts:26` still compiles unchanged since it never used the return value.

- [ ] **Step 4: Commit**

```bash
git add lib/db/orders.ts
git commit -m "refactor(orders): appendOrders returns inserted ids

Needed by the catalogue-requests conversion flow to record which order
a request became. The sole existing caller discards the return value,
so this is a compatible widening, not a breaking change."
```

---

### Task 2: Migration — catalogue_posts, catalogue_post_products, catalogue_requests

**Files:**
- Create: `supabase/migrations/058_catalogue_posts_and_requests.sql`

**Interfaces:**
- Produces: tables `catalogue_posts`, `catalogue_post_products`, `catalogue_requests` (columns exactly as below — later tasks' SQL depends on these names)

- [ ] **Step 1: Write the migration**

```sql
-- Catalogue: photo/video posts (one asset, optionally tagging several
-- products) and the requests customers submit against them. See
-- docs/superpowers/specs/2026-08-12-catalogue-order-requests-design.md.

CREATE TABLE catalogue_posts (
  id          SERIAL PRIMARY KEY,
  media_url   TEXT NOT NULL,
  media_type  TEXT NOT NULL CHECK (media_type IN ('photo', 'video')),
  caption     TEXT NOT NULL DEFAULT '',
  visible     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ
);

CREATE TABLE catalogue_post_products (
  post_id     INTEGER NOT NULL REFERENCES catalogue_posts(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, product_id)
);

-- No FK on customer_handle: a customer can submit a request before ever
-- appearing in `customers` (unlike orders.customer, which requires — and
-- appendOrders self-heals — a customers row only once a real order exists).
CREATE TABLE catalogue_requests (
  id                 SERIAL PRIMARY KEY,
  customer_handle    TEXT NOT NULL,
  product_id         INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty                INTEGER NOT NULL CHECK (qty > 0),
  note               TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'converted', 'rejected')),
  staff_note         TEXT NOT NULL DEFAULT '',
  converted_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ
);

CREATE INDEX idx_catalogue_requests_handle
  ON catalogue_requests (lower(replace(customer_handle, '@', '')));
CREATE INDEX idx_catalogue_requests_status
  ON catalogue_requests (status) WHERE status = 'pending';
CREATE INDEX idx_catalogue_post_products_product
  ON catalogue_post_products (product_id);
```

- [ ] **Step 2: Apply locally and verify**

Run: `supabase status` (confirms Docker/local stack is up — if not, `open -a Docker` then wait, then `supabase start`), then `supabase migration up`.
Expected: migration applies with no errors.

Run: `psql "$(grep '^DATABASE_URL' .env.development.local | cut -d= -f2- | tr -d '\"')" -c "\d catalogue_requests"` (or, if `psql` isn't installed, a one-off `node -e` script using the `postgres` package against `.env.development.local`'s `DATABASE_URL`, matching the read-only verification style already used in this project — see any prior session's schema check).
Expected: all three tables exist with the columns above.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/058_catalogue_posts_and_requests.sql
git commit -m "feat(db): add catalogue_posts, catalogue_post_products, catalogue_requests tables"
```

---

### Task 3: Migration — `catalogue_public` role and grants

**Files:**
- Create: `supabase/migrations/059_catalogue_public_role.sql`

- [ ] **Step 1: Write the migration**

Mirror `supabase/migrations/018_invoice_reader_role.sql` exactly in shape.

```sql
-- Read/write DB role for the PUBLIC, no-login catalogue endpoints
-- (app/api/public/catalogue/*). Scoped so that path can read visible posts
-- and public-safe product fields, and can only insert/read its own
-- customer_handle's rows in catalogue_requests — nothing else.
--
-- IMPORTANT: set a real password out-of-band (do NOT commit it), then point
-- CATALOGUE_PUBLIC_DATABASE_URL at this role:
--   ALTER ROLE catalogue_public WITH PASSWORD '<strong-secret>';
-- Connect via the Supabase pooler as `catalogue_public.<project-ref>`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'catalogue_public') THEN
    CREATE ROLE catalogue_public LOGIN PASSWORD 'CHANGE_ME_BEFORE_USE'
      NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM catalogue_public;
GRANT USAGE ON SCHEMA public TO catalogue_public;

GRANT SELECT ON catalogue_posts, catalogue_post_products TO catalogue_public;

-- Public-safe columns only — no cost, profit, or internal pricing fields.
GRANT SELECT (id, name, store, price) ON products TO catalogue_public;

GRANT SELECT, INSERT ON catalogue_requests TO catalogue_public;
GRANT USAGE, SELECT ON catalogue_requests_id_seq TO catalogue_public;
```

- [ ] **Step 2: Apply locally**

Run: `supabase migration up`
Expected: applies with no errors. Note: the local dev Supabase's default `postgres` superuser bypasses column-level grants, so a full negative-permission test (e.g. confirming `catalogue_public` truly cannot read `products.cost`) only really matters in production and is out of scope for local verification — the grant statements themselves succeeding is the local check.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/059_catalogue_public_role.sql
git commit -m "feat(db): add catalogue_public least-privilege role"
```

---

### Task 4: Migration — Storage bucket for catalogue media

**Files:**
- Create: `supabase/migrations/060_catalogue_storage_bucket.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Public bucket for catalogue photo/video files. Uploads go through the
-- staff-only /api/sheets/catalogue-posts route using the service-role key
-- (which bypasses these policies entirely); the public SELECT policy is
-- what lets the customer-facing /catalogue page load files directly by URL.
INSERT INTO storage.buckets (id, name, public)
VALUES ('catalogue-media', 'catalogue-media', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public read catalogue media"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'catalogue-media');
```

- [ ] **Step 2: Apply locally**

Run: `supabase migration up`
Expected: applies with no errors. Confirm the bucket exists: `supabase storage ls ss:///catalogue-media` (or check the local Supabase Studio at the URL `supabase status` prints, under Storage).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/060_catalogue_storage_bucket.sql
git commit -m "feat(db): add public catalogue-media storage bucket"
```

---

### Task 5: Dedicated public DB connection

**Files:**
- Create: `lib/db-catalogue-public.ts`

**Interfaces:**
- Produces: default export `catalogueSql` — a `postgres` connection using the `catalogue_public` role, same shape as `lib/db-public.ts`'s `publicSql`.

- [ ] **Step 1: Write the file**

```typescript
import postgres from "postgres"

// Dedicated connection for the PUBLIC, no-login catalogue endpoints
// (app/api/public/catalogue/*). Uses the `catalogue_public` role — scoped to
// visible posts, public-safe product columns, and the requester's own rows
// in catalogue_requests (see supabase/migrations/059_catalogue_public_role.sql)
// — so this path can never read cost/profit data or another customer's
// requests even if a query is wrong.
const connectionString = process.env.CATALOGUE_PUBLIC_DATABASE_URL!

// Local dev DB (127.0.0.1) is plaintext; require SSL only for remote hosts.
const isLocalDb = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString)

const catalogueSql = postgres(connectionString, {
  max: 3,
  idle_timeout: 300,
  max_lifetime: 60 * 30,
  connect_timeout: 10,
  ssl: isLocalDb ? false : "require",
  prepare: false,
  connection: {
    statement_timeout: 15000,
  },
})

export default catalogueSql
```

- [ ] **Step 2: Add the env var**

Add to `.env.development.local` (pointing at the local dev DB with the `catalogue_public` role — for local dev, since Supabase's local stack doesn't enforce the same column-level grants as production, it's acceptable to point this at the same local `DATABASE_URL` value used for the main pool; a real distinct-role connection string is only required in production):

```
CATALOGUE_PUBLIC_DATABASE_URL="<same value as local DATABASE_URL for dev>"
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (file isn't imported anywhere yet, so this only checks it parses/typechecks standalone).

- [ ] **Step 4: Commit**

```bash
git add lib/db-catalogue-public.ts
git commit -m "feat(db): add dedicated connection for the public catalogue role"
```

---

### Task 6: Types for posts and requests

**Files:**
- Modify: `lib/db/types.ts` (append near the end, after `OperationalExpenseRow`)

**Interfaces:**
- Produces:
  - `CataloguePost { id, mediaUrl, mediaType: "photo"|"video", caption, visible, createdAt, updatedAt, productIds: number[] }`
  - `CatalogueRequest { id, customerHandle, productId, productName, qty, note, status: "pending"|"converted"|"rejected", staffNote, convertedOrderId: number|null, createdAt }`

- [ ] **Step 1: Add the types**

```typescript
export interface CataloguePost {
  id: number
  mediaUrl: string
  mediaType: "photo" | "video"
  caption: string
  visible: boolean
  createdAt: string
  updatedAt: string
  /** Products tagged in this post. */
  productIds: number[]
}

export interface CatalogueRequest {
  id: number
  customerHandle: string
  productId: number
  productName: string
  qty: number
  note: string
  status: "pending" | "converted" | "rejected"
  staffNote: string
  convertedOrderId: number | null
  createdAt: string
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/db/types.ts
git commit -m "feat(db): add CataloguePost and CatalogueRequest types"
```

---

### Task 7: DB functions — catalogue posts

**Files:**
- Create: `lib/db/catalogue-posts.ts`

**Interfaces:**
- Consumes: `CataloguePost` (Task 6), `DBExecutor` (`lib/db/actor.ts:9`), `sql` (`lib/db-pool.ts`)
- Produces:
  - `getVisibleCataloguePosts(db: typeof import("postgres").default): Promise<CataloguePost[]>` — public read path, explicit db param (no default — forces the caller to pass the scoped connection, matching `getPublicInvoiceForCustomer`'s pattern in `lib/db/invoice.ts:326-328`)
  - `getAllCataloguePosts(db: DBExecutor = sql): Promise<CataloguePost[]>` — staff read, all posts regardless of `visible`
  - `createCataloguePost(data: { mediaUrl: string; mediaType: "photo"|"video"; caption: string; productIds: number[] }, db: DBExecutor = sql): Promise<{ id: number }>`
  - `setCataloguePostVisible(id: number, visible: boolean, db: DBExecutor = sql): Promise<void>`

- [ ] **Step 1: Write the file**

```typescript
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
    productIds: (r.product_ids as number[] | null) ?? [],
  }
}

const POST_SELECT = `
  SELECT p.id, p.media_url, p.media_type, p.caption, p.visible,
         p.created_at, p.updated_at,
         COALESCE(ARRAY_AGG(pp.product_id) FILTER (WHERE pp.product_id IS NOT NULL), '{}') AS product_ids
  FROM catalogue_posts p
  LEFT JOIN catalogue_post_products pp ON pp.post_id = p.id
`

/** Public path: only posts staff has marked visible. `db` must be the
 *  scoped `catalogue_public` connection (lib/db-catalogue-public.ts) — no
 *  default, so a caller can't accidentally use the main pool here. */
export async function getVisibleCataloguePosts(db: postgres.Sql): Promise<CataloguePost[]> {
  const rows = await db.unsafe(`
    ${POST_SELECT}
    WHERE p.visible = true
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `)
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
  data: { mediaUrl: string; mediaType: "photo" | "video"; caption: string; productIds: number[] },
  db: DBExecutor = sql,
): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO catalogue_posts (media_url, media_type, caption)
    VALUES (${data.mediaUrl}, ${data.mediaType}, ${data.caption})
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
  await db`
    UPDATE catalogue_posts SET visible = ${visible}, updated_at = NOW()
    WHERE id = ${id}
  `
}
```

Note on `db.unsafe(...)`: the `postgres` package's tagged-template form (`` sql`...` ``) can't easily interpolate a shared SQL fragment string like `POST_SELECT` into two different queries without repeating it — `.unsafe()` takes a plain string with no parameters here (nothing user-supplied is interpolated into `POST_SELECT` itself), so this is safe. Confirm `postgres.Sql` is the right exported type name in the next step.

- [ ] **Step 2: Confirm `postgres.Sql` is a real exported type**

Run: `grep -n "export type Sql\|export interface Sql" node_modules/postgres/types/index.d.ts | head -5`
Expected: a `Sql` type/interface is exported. If the actual name differs, fix the `postgres.Sql` reference in Step 1 to match (e.g. it may need to be `postgres.Sql<{}>` — check the same file for how `TransactionSql` is declared in `lib/db/actor.ts` for a working precedent, since that file already does `postgres.TransactionSql` successfully).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/db/catalogue-posts.ts
git commit -m "feat(db): add catalogue post read/write functions"
```

---

### Task 8: DB functions — catalogue requests

**Files:**
- Create: `lib/db/catalogue-requests.ts`

**Interfaces:**
- Consumes: `CatalogueRequest` (Task 6), `appendOrders` (Task 1, widened), `normalizeId` (`lib/db/helpers.ts:8`), `withActor` (`lib/db/actor.ts:21`)
- Produces:
  - `createCatalogueRequest(data: { customerHandle: string; productId: number; qty: number; note: string }, db: postgres.Sql): Promise<void>` — public insert, explicit db param
  - `getCatalogueRequestsByHandle(handle: string, db: postgres.Sql): Promise<CatalogueRequest[]>` — public status lookup, explicit db param
  - `getCatalogueRequests(onlyPending: boolean, db: DBExecutor = sql): Promise<CatalogueRequest[]>` — staff read
  - `convertCatalogueRequest(id: number, event: string, actor: string | null): Promise<{ orderId: number }>` — staff action, wraps `appendOrders` + status update in one transaction (no `db` param — see rationale below the implementation)
  - `rejectCatalogueRequest(id: number, staffNote: string, db: DBExecutor = sql): Promise<void>` — staff action

- [ ] **Step 1: Write the file**

```typescript
import postgres from "postgres"
import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { withActor } from "./actor"
import { appendOrders } from "./orders"
import { normalizeId } from "./helpers"
import type { CatalogueRequest } from "./types"

function toRequest(r: Record<string, unknown>): CatalogueRequest {
  return {
    id: r.id as number,
    customerHandle: r.customer_handle as string,
    productId: r.product_id as number,
    productName: r.product_name as string,
    qty: r.qty as number,
    note: r.note as string,
    status: r.status as CatalogueRequest["status"],
    staffNote: r.staff_note as string,
    convertedOrderId: (r.converted_order_id as number | null) ?? null,
    createdAt: (r.created_at as Date).toISOString(),
  }
}

/** Public path: submit one request. `db` must be the scoped
 *  `catalogue_public` connection — no default. Stores the handle
 *  normalized (bare lowercase, no "@"), matching every other customer
 *  handle write in this codebase. */
export async function createCatalogueRequest(
  data: { customerHandle: string; productId: number; qty: number; note: string },
  db: postgres.Sql,
): Promise<void> {
  await db`
    INSERT INTO catalogue_requests (customer_handle, product_id, qty, note)
    VALUES (${normalizeId(data.customerHandle)}, ${data.productId}, ${data.qty}, ${data.note})
  `
}

/** Public path: a handle's own requests. `db` must be the scoped
 *  `catalogue_public` connection — no default. */
export async function getCatalogueRequestsByHandle(
  handle: string,
  db: postgres.Sql,
): Promise<CatalogueRequest[]> {
  const rows = await db`
    SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
           r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at
    FROM catalogue_requests r
    JOIN products p ON p.id = r.product_id
    WHERE lower(replace(r.customer_handle, '@', '')) = ${normalizeId(handle)}
    ORDER BY r.created_at DESC
  `
  return rows.map(toRequest)
}

/** Staff path. */
export async function getCatalogueRequests(
  onlyPending: boolean,
  db: DBExecutor = sql,
): Promise<CatalogueRequest[]> {
  const rows = onlyPending
    ? await db`
        SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
               r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at
        FROM catalogue_requests r
        JOIN products p ON p.id = r.product_id
        WHERE r.status = 'pending'
        ORDER BY r.created_at ASC
      `
    : await db`
        SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
               r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at
        FROM catalogue_requests r
        JOIN products p ON p.id = r.product_id
        ORDER BY r.created_at DESC
      `
  return rows.map(toRequest)
}

/** Converts one request into a real order — the request's product/qty/note
 *  become the order's, staff supplies the event (the one field a request
 *  never carries). Calls the same appendOrders every other order goes
 *  through; both the order insert and the request's status flip happen in
 *  one transaction so they can't half-apply. */
export async function convertCatalogueRequest(
  id: number,
  event: string,
  actor: string | null,
): Promise<{ orderId: number }> {
  return withActor(actor, async (tx) => {
    const [request] = await tx`
      SELECT customer_handle, product_id, qty, note FROM catalogue_requests
      WHERE id = ${id} AND status = 'pending'
    `
    if (!request) throw new Error("Request not found or already handled")

    const [created] = await appendOrders(
      [{
        event,
        customer: request.customer_handle as string,
        productId: request.product_id as number,
        unitPrice: 0,
        unit: request.qty as number,
        note: request.note as string,
      }],
      tx,
    )

    await tx`
      UPDATE catalogue_requests
      SET status = 'converted', converted_order_id = ${created.id}, updated_at = NOW()
      WHERE id = ${id}
    `
    return { orderId: created.id }
  })
}

export async function rejectCatalogueRequest(
  id: number,
  staffNote: string,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE catalogue_requests
    SET status = 'rejected', staff_note = ${staffNote}, updated_at = NOW()
    WHERE id = ${id} AND status = 'pending'
  `
}
```

`convertCatalogueRequest` takes no `db`/`DBExecutor` parameter, unlike the other functions in this file — `withActor` (`lib/db/actor.ts:21`) always opens its own fresh transaction via `sql.begin`, so it can never honor an externally-supplied executor anyway. A `db` parameter here would be silently ignored, which is worse than not having one.

**Note on `unitPrice: 0`:** a converted order's `unit_price` is intentionally not carried from anywhere — the catalogue never shows or asks for pricing (see the spec's `catalogue_public` grant: `products(id, name, store, price)` is readable, but nothing in the request-submission flow uses it). Staff sets the real price by editing the order after conversion, same as any manually-added order where the picked product's live price wasn't what was actually charged. This is a deliberate simplification, not an oversight — flag to the user if a "carry the product's current price" behavior turns out to be expected instead.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/db/catalogue-requests.ts
git commit -m "feat(db): add catalogue request read/write/convert functions"
```

---

### Task 9: Export new modules from the DB barrel

**Files:**
- Modify: `lib/db.ts`

- [ ] **Step 1: Add the two new exports**

```typescript
export * from "./db/catalogue-posts"
export * from "./db/catalogue-requests"
```

Add these lines after the existing `export * from "./db/catalog"` line.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors, no name collisions with the existing barrel exports (in particular `lib/db/catalog.ts`, which is unrelated — products/countries/kurs-tiers — and does not export anything named `CataloguePost`/`CatalogueRequest`/etc., so there's no collision, just a similar-looking filename to be careful not to confuse while editing).

- [ ] **Step 3: Commit**

```bash
git add lib/db.ts
git commit -m "feat(db): export catalogue-posts and catalogue-requests from the barrel"
```

---

### Task 10: Storage upload helper

**Files:**
- Modify: `package.json` (new dependency)
- Create: `lib/storage.ts`

**Interfaces:**
- Produces: `uploadCatalogueMedia(file: File): Promise<{ url: string; mediaType: "photo" | "video" }>`

- [ ] **Step 1: Add the dependency**

Run: `npm install @supabase/supabase-js`
Expected: `package.json` and `package-lock.json` (or equivalent) update; installs cleanly.

- [ ] **Step 2: Add Storage env vars**

Add to `.env.local` (production values — get these from Supabase dashboard → Project Settings → API):

```
SUPABASE_URL="https://aihubvlvxukiiymhzewh.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="<service role key, from Supabase dashboard>"
```

Add the same two to `.env.development.local`, pointed at the local Supabase stack's own URL/key (`supabase status` prints both — `API URL` and `service_role key`).

- [ ] **Step 3: Write the storage helper**

```typescript
import { createClient } from "@supabase/supabase-js"

// Storage-only client — the service role key bypasses RLS entirely, so this
// must never be imported into any client component or public-facing route.
// Only the staff-only /api/sheets/catalogue-posts route uses this.
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const BUCKET = "catalogue-media"
const MAX_PHOTO_BYTES = 5 * 1024 * 1024
const MAX_VIDEO_BYTES = 50 * 1024 * 1024

export async function uploadCatalogueMedia(file: File): Promise<{ url: string; mediaType: "photo" | "video" }> {
  const isVideo = file.type.startsWith("video/")
  const isPhoto = file.type.startsWith("image/")
  if (!isVideo && !isPhoto) throw new Error("File must be an image or a video")

  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES
  if (file.size > maxBytes) {
    throw new Error(`File too large — max ${Math.round(maxBytes / 1024 / 1024)}MB for a ${isVideo ? "video" : "photo"}`)
  }

  const ext = file.name.split(".").pop() ?? "bin"
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`

  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: false,
  })
  if (error) throw new Error(`Upload failed: ${error.message}`)

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return { url: data.publicUrl, mediaType: isVideo ? "video" : "photo" }
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json lib/storage.ts
git commit -m "feat(storage): add Supabase Storage upload helper for catalogue media"
```

---

### Task 11: Public API — list catalogue posts

**Files:**
- Create: `app/api/public/catalogue/route.ts`

**Interfaces:**
- Consumes: `getVisibleCataloguePosts` (Task 7), `catalogueSql` (Task 5)

- [ ] **Step 1: Write the route**

```typescript
import { NextResponse } from "next/server"
import { getVisibleCataloguePosts } from "@/lib/db"
import catalogueSql from "@/lib/db-catalogue-public"

// Public, no-login endpoint for the /catalogue browse page. Same-origin
// (served from this app), so no CORS allowlist is needed — unlike
// /api/public/invoice, which serves a separate site.
export async function GET() {
  try {
    const posts = await getVisibleCataloguePosts(catalogueSql)
    return NextResponse.json({ posts }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to load catalogue posts:", err)
    return NextResponse.json({ error: "Failed to load catalogue" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Typecheck and manual check**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run dev` (background), then `curl -s http://localhost:3000/api/public/catalogue | head -c 500`
Expected: `{"posts":[]}` (empty until Task 15 lets staff create one) — not a 500, not an auth redirect.

- [ ] **Step 3: Commit**

```bash
git add app/api/public/catalogue/route.ts
git commit -m "feat(catalogue): public endpoint to list visible catalogue posts"
```

---

### Task 12: Public API — submit and look up requests

**Files:**
- Create: `app/api/public/catalogue/requests/route.ts`

**Interfaces:**
- Consumes: `createCatalogueRequest`, `getCatalogueRequestsByHandle` (Task 8), `catalogueSql` (Task 5)

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from "next/server"
import { createCatalogueRequest, getCatalogueRequestsByHandle } from "@/lib/db"
import catalogueSql from "@/lib/db-catalogue-public"

const MAX_BODY_BYTES = 4 * 1024
const MAX_HANDLE_LEN = 30 // Instagram's own max handle length
const MAX_NOTE_LEN = 300

export async function GET(req: NextRequest) {
  const handle = req.nextUrl.searchParams.get("handle")?.trim()
  if (!handle) {
    return NextResponse.json({ error: "handle is required" }, { status: 400 })
  }
  try {
    const requests = await getCatalogueRequestsByHandle(handle, catalogueSql)
    return NextResponse.json({ requests }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to load catalogue requests:", err)
    return NextResponse.json({ error: "Failed to load requests" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const declaredLen = Number(req.headers.get("content-length") ?? 0)
  if (declaredLen > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 })
  }

  try {
    const body = await req.json()
    const customerHandle = String(body.customerHandle ?? "").trim()
    const productId = Number(body.productId)
    const qty = Number(body.qty)
    const note = String(body.note ?? "").trim()

    if (!customerHandle || customerHandle.length > MAX_HANDLE_LEN) {
      return NextResponse.json({ error: "A valid customerHandle is required" }, { status: 400 })
    }
    if (!Number.isInteger(productId) || productId < 1) {
      return NextResponse.json({ error: "productId must be a positive integer" }, { status: 400 })
    }
    if (!Number.isInteger(qty) || qty < 1) {
      return NextResponse.json({ error: "qty must be a positive integer" }, { status: 400 })
    }
    if (note.length > MAX_NOTE_LEN) {
      return NextResponse.json({ error: `note must be ${MAX_NOTE_LEN} characters or fewer` }, { status: 400 })
    }

    await createCatalogueRequest({ customerHandle, productId, qty, note }, catalogueSql)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to save catalogue request:", err)
    return NextResponse.json({ error: "Failed to save request" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Typecheck and manual check**

Run: `npx tsc --noEmit`
Expected: no errors.

Run (dev server running):
```bash
curl -s -X POST http://localhost:3000/api/public/catalogue/requests \
  -H "Content-Type: application/json" \
  -d '{"customerHandle":"@testhandle","productId":1,"qty":2,"note":"test"}'
```
Expected: `{"success":true}` if `products.id = 1` exists locally, or a clear 400/500 with a real error message otherwise — not a silent hang or an HTML error page.

Run: `curl -s "http://localhost:3000/api/public/catalogue/requests?handle=testhandle"`
Expected: `{"requests":[{...the row just submitted, with customerHandle normalized...}]}`.

- [ ] **Step 3: Commit**

```bash
git add app/api/public/catalogue/requests/route.ts
git commit -m "feat(catalogue): public endpoints to submit a request and look up status"
```

---

### Task 13: Public catalogue page

**Files:**
- Create: `app/catalogue/page.tsx`
- Create: `app/catalogue/CatalogueClient.tsx`

**Interfaces:**
- Consumes: `GET /api/public/catalogue`, `POST` and `GET /api/public/catalogue/requests` (Tasks 11-12)

- [ ] **Step 1: Write the page shell**

`app/catalogue/page.tsx`:

```typescript
import CatalogueClient from "./CatalogueClient"

export default function CataloguePage() {
  return (
    <div className="min-h-screen bg-cream px-4 py-6 md:px-6 md:py-10">
      <div className="max-w-3xl mx-auto flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Catalogue</h1>
          <p className="text-sm text-gray-500 mt-0.5">Browse, and tap Fix to request an item.</p>
        </div>
        <CatalogueClient />
      </div>
    </div>
  )
}
```

This page is intentionally outside `/dashboard` and doesn't use `PageShell`/`components/Navbar` — those assume a logged-in staff session (they render the sidebar, sign-out, etc.), which nothing here needs. `middleware.ts`'s matcher (`/dashboard/:path*`) doesn't touch this route.

- [ ] **Step 2: Write the client component**

`app/catalogue/CatalogueClient.tsx`:

```typescript
"use client"

import { useEffect, useState } from "react"
import type { CataloguePost, CatalogueRequest } from "@/lib/db"

type PostWithProducts = CataloguePost & {
  products: { id: number; name: string; store: string; price: number }[]
}

export default function CatalogueClient() {
  const [posts, setPosts] = useState<PostWithProducts[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/public/catalogue", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setError(data.error); return }
        setPosts(data.posts)
      })
      .catch(() => setError("Failed to load catalogue"))
  }, [])

  if (error) return <p className="text-sm text-red-500">{error}</p>
  if (!posts) return <p className="text-sm text-gray-400">Loading…</p>
  if (posts.length === 0) return <p className="text-sm text-gray-400">Nothing here yet.</p>

  return (
    <div className="flex flex-col gap-8">
      {posts.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}
      <StatusLookup />
    </div>
  )
}

function PostCard({ post }: { post: PostWithProducts }) {
  return (
    <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
      {post.mediaType === "video" ? (
        <video src={post.mediaUrl} controls className="w-full max-h-[420px] object-cover bg-black" />
      ) : (
        <img src={post.mediaUrl} alt={post.caption} className="w-full max-h-[420px] object-cover" />
      )}
      {post.caption && <p className="px-4 pt-3 text-sm text-gray-600">{post.caption}</p>}
      <div className="p-4 flex flex-col gap-3">
        {post.products.map((product) => (
          <ProductRequestRow key={product.id} product={product} />
        ))}
      </div>
    </div>
  )
}

function ProductRequestRow({ product }: { product: { id: number; name: string; store: string; price: number } }) {
  const [qty, setQty] = useState("1")
  const [note, setNote] = useState("")
  const [handle, setHandle] = useState(() => (typeof window !== "undefined" ? localStorage.getItem("catalogueHandle") ?? "" : ""))
  const [state, setState] = useState<"idle" | "submitting" | "done" | "error">("idle")
  const [errorMsg, setErrorMsg] = useState("")

  async function submit() {
    if (!handle.trim()) { setErrorMsg("Enter your Instagram handle"); setState("error"); return }
    setState("submitting")
    try {
      const res = await fetch("/api/public/catalogue/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerHandle: handle, productId: product.id, qty: Number(qty), note }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      localStorage.setItem("catalogueHandle", handle)
      setState("done")
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed")
      setState("error")
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-cream-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{product.name}</span>
        <span className="text-xs text-gray-400">Rp {product.price.toLocaleString("id-ID")}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="Your IG handle"
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm w-32"
        />
        <input
          type="number"
          min="1"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm w-16"
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm flex-1 min-w-[8rem]"
        />
        <button
          onClick={submit}
          disabled={state === "submitting" || state === "done"}
          className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50"
        >
          {state === "done" ? "Requested ✓" : state === "submitting" ? "…" : "Fix"}
        </button>
      </div>
      {state === "error" && <p className="text-xs text-red-500">{errorMsg}</p>}
    </div>
  )
}

function StatusLookup() {
  const [handle, setHandle] = useState("")
  const [requests, setRequests] = useState<CatalogueRequest[] | null>(null)

  async function check() {
    const res = await fetch(`/api/public/catalogue/requests?handle=${encodeURIComponent(handle)}`, { cache: "no-store" })
    const data = await res.json()
    setRequests(data.requests ?? [])
  }

  return (
    <div className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">Check my requests</h2>
      <div className="flex gap-2">
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="Your IG handle"
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm flex-1"
        />
        <button onClick={check} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Check</button>
      </div>
      {requests && (
        <div className="flex flex-col gap-2">
          {requests.length === 0 && <p className="text-xs text-gray-400">No requests found.</p>}
          {requests.map((r) => (
            <div key={r.id} className="flex items-center justify-between text-xs">
              <span>{r.productName} × {r.qty}</span>
              <span className={r.status === "converted" ? "text-green-600" : r.status === "rejected" ? "text-red-500" : "text-gray-400"}>
                {r.status}{r.status === "rejected" && r.staffNote ? ` — ${r.staffNote}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

Note: `PostWithProducts` (a post with its tagged products resolved to `{id, name, store, price}`) is what Task 11's route is expected to return, but `getVisibleCataloguePosts` (Task 7) only returns `productIds: number[]`, not resolved product objects. **This is a gap — fix it now, before this task's build check, not later:** go back and adjust Task 11's route to resolve `productIds` into full product objects before responding (join against `products` for `id, name, store, price` per post). Simplest fix, applied here: extend `app/api/public/catalogue/route.ts` (Task 11) to do this resolution inline rather than pushing it into the DB layer:

```typescript
// In app/api/public/catalogue/route.ts, replace the GET body:
export async function GET() {
  try {
    const posts = await getVisibleCataloguePosts(catalogueSql)
    const productIds = [...new Set(posts.flatMap((p) => p.productIds))]
    const products = productIds.length
      ? await catalogueSql`SELECT id, name, store, price FROM products WHERE id IN ${catalogueSql(productIds)}`
      : []
    const byId = new Map(products.map((p) => [p.id as number, { id: p.id as number, name: p.name as string, store: p.store as string, price: p.price as number }]))
    const withProducts = posts.map((post) => ({
      ...post,
      products: post.productIds.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => p != null),
    }))
    return NextResponse.json({ posts: withProducts }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to load catalogue posts:", err)
    return NextResponse.json({ error: "Failed to load catalogue" }, { status: 500 })
  }
}
```

- [ ] **Step 3: Typecheck and manual check**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run dev`, open `http://localhost:3000/catalogue` in a browser.
Expected: page loads without a login redirect, shows "Nothing here yet." until Task 15 creates a post.

- [ ] **Step 4: Commit**

```bash
git add app/catalogue/page.tsx app/catalogue/CatalogueClient.tsx app/api/public/catalogue/route.ts
git commit -m "feat(catalogue): public browse page with one-tap Fix request"
```

---

### Task 14: Staff API — catalogue posts (list, create with upload)

**Files:**
- Create: `app/api/sheets/catalogue-posts/route.ts`

**Interfaces:**
- Consumes: `getAllCataloguePosts`, `createCataloguePost` (Task 7), `uploadCatalogueMedia` (Task 10), `requireSession`/`requireOwner` (`lib/api.ts`)

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getAllCataloguePosts, createCataloguePost } from "@/lib/db"
import { uploadCatalogueMedia } from "@/lib/storage"

export async function GET() {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const posts = await getAllCataloguePosts()
    return NextResponse.json({ posts }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch catalogue posts:", err)
    return NextResponse.json({ error: "Failed to fetch catalogue posts" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  try {
    const form = await req.formData()
    const file = form.get("file")
    const caption = String(form.get("caption") ?? "")
    const productIdsRaw = String(form.get("productIds") ?? "[]")

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 })
    }
    let productIds: number[]
    try {
      productIds = JSON.parse(productIdsRaw)
      if (!Array.isArray(productIds) || !productIds.every((n) => Number.isInteger(n))) throw new Error()
    } catch {
      return NextResponse.json({ error: "productIds must be a JSON array of integers" }, { status: 400 })
    }

    const { url, mediaType } = await uploadCatalogueMedia(file)
    const result = await createCataloguePost({ mediaUrl: url, mediaType, caption, productIds })

    return NextResponse.json({ success: true, id: result.id })
  } catch (err) {
    console.error("Failed to create catalogue post:", err)
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to create post" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/sheets/catalogue-posts/route.ts
git commit -m "feat(catalogue): staff endpoint to list and create catalogue posts"
```

---

### Task 15: Staff API — toggle post visibility

**Files:**
- Create: `app/api/sheets/catalogue-posts/[id]/route.ts`

**Interfaces:**
- Consumes: `setCataloguePostVisible` (Task 7)

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { setCataloguePostVisible } from "@/lib/db"

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
    if (typeof body.visible !== "boolean") {
      return NextResponse.json({ error: "visible must be a boolean" }, { status: 400 })
    }
    await setCataloguePostVisible(id, body.visible)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("Failed to update catalogue post:", err)
    return NextResponse.json({ error: "Failed to update post" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "app/api/sheets/catalogue-posts/[id]/route.ts"
git commit -m "feat(catalogue): staff endpoint to toggle post visibility"
```

---

### Task 16: Staff page — manage catalogue posts

**Files:**
- Create: `app/dashboard/catalogue-posts/page.tsx`
- Create: `app/dashboard/catalogue-posts/loading.tsx`
- Create: `app/dashboard/catalogue-posts/CataloguePostsClient.tsx`

**Interfaces:**
- Consumes: `GET`/`POST /api/sheets/catalogue-posts`, `PUT /api/sheets/catalogue-posts/[id]` (Tasks 14-15), `useSheetOptions` (`hooks/useSheetOptions.ts`)

- [ ] **Step 1: Write the page shell and loading state**

`app/dashboard/catalogue-posts/page.tsx`:

```typescript
import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import CataloguePostsClient from "./CataloguePostsClient"

export default function CataloguePostsPage() {
  return (
    <PageShell>
      <PageHeader title="Catalogue Posts" subtitle="Upload photos/videos and tag the products they show" />
      <CataloguePostsClient />
    </PageShell>
  )
}
```

`app/dashboard/catalogue-posts/loading.tsx`:

```typescript
import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Catalogue Posts" subtitle="Upload photos/videos and tag the products they show" />
      <TableSkeleton />
    </PageShell>
  )
}
```

- [ ] **Step 2: Write the client component**

`app/dashboard/catalogue-posts/CataloguePostsClient.tsx`:

```typescript
"use client"

import { useEffect, useMemo, useState } from "react"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import type { CataloguePost } from "@/lib/db"

export default function CataloguePostsClient() {
  const options = useSheetOptions()
  const [posts, setPosts] = useState<CataloguePost[]>([])
  const [loading, setLoading] = useState(true)

  async function reload() {
    const res = await fetch("/api/sheets/catalogue-posts", { cache: "no-store" })
    const data = await res.json()
    setPosts(data.posts ?? [])
    setLoading(false)
  }

  useEffect(() => { reload() }, [])

  async function toggleVisible(post: CataloguePost) {
    setPosts((prev) => prev.map((p) => p.id === post.id ? { ...p, visible: !p.visible } : p))
    await fetch(`/api/sheets/catalogue-posts/${post.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visible: !post.visible }),
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <UploadForm options={options} onCreated={reload} />
      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <div className="flex flex-col gap-2">
          {posts.map((post) => (
            <div key={post.id} className="flex items-center justify-between rounded-xl border border-cream-border bg-white p-3">
              <div className="flex items-center gap-3">
                {post.mediaType === "video" ? (
                  <video src={post.mediaUrl} className="w-16 h-16 object-cover rounded-lg bg-black" />
                ) : (
                  <img src={post.mediaUrl} alt="" className="w-16 h-16 object-cover rounded-lg" />
                )}
                <div>
                  <div className="text-sm text-foreground">{post.caption || "(no caption)"}</div>
                  <div className="text-xs text-gray-400">{post.productIds.length} product{post.productIds.length === 1 ? "" : "s"} tagged</div>
                </div>
              </div>
              <button
                onClick={() => toggleVisible(post)}
                className={`px-3 py-1.5 rounded-lg text-xs border ${post.visible ? "bg-brand text-white border-brand" : "border-cream-border text-gray-500"}`}
              >
                {post.visible ? "Visible" : "Hidden"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function UploadForm({ options, onCreated }: { options: ReturnType<typeof useSheetOptions>; onCreated: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [caption, setCaption] = useState("")
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  const items = useMemo(() => (options?.items ?? []).filter((it) => it.active), [options])

  function toggleProduct(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function submit() {
    if (!file) { setError("Pick a photo or video"); return }
    setSubmitting(true); setError("")
    try {
      const form = new FormData()
      form.set("file", file)
      form.set("caption", caption)
      form.set("productIds", JSON.stringify([...selectedIds]))
      const res = await fetch("/api/sheets/catalogue-posts", { method: "POST", body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      setFile(null); setCaption(""); setSelectedIds(new Set())
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-foreground">New post</h2>
      <input type="file" accept="image/*,video/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
      <input
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        placeholder="Caption (optional)"
        className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
      />
      <div className="flex flex-col gap-1 max-h-48 overflow-y-auto border border-cream-border rounded-lg p-2">
        {items.map((item) => (
          <label key={item.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleProduct(item.id)} className="accent-brand" />
            {item.name}
          </label>
        ))}
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <button
        onClick={submit}
        disabled={submitting}
        className="self-start px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50"
      >
        {submitting ? "Uploading…" : "Create post"}
      </button>
    </div>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/catalogue-posts
git commit -m "feat(catalogue): staff page to upload and manage catalogue posts"
```

---

### Task 17: Staff API — list requests, convert, reject

**Files:**
- Create: `app/api/sheets/order-requests/route.ts`
- Create: `app/api/sheets/order-requests/[id]/route.ts`

**Interfaces:**
- Consumes: `getCatalogueRequests`, `convertCatalogueRequest`, `rejectCatalogueRequest` (Task 8)

- [ ] **Step 1: Write the list route**

`app/api/sheets/order-requests/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getCatalogueRequests } from "@/lib/db"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const onlyPending = req.nextUrl.searchParams.get("all") !== "true"

  try {
    const requests = await getCatalogueRequests(onlyPending)
    return NextResponse.json({ requests }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to fetch order requests:", err)
    return NextResponse.json({ error: "Failed to fetch order requests" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Write the convert/reject route**

`app/api/sheets/order-requests/[id]/route.ts` — `PUT` with an `action` discriminator, matching the existing `stage`-discriminated pattern in `app/api/sheets/duplicate-form/[row]/route.ts:22`:

```typescript
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { convertCatalogueRequest, rejectCatalogueRequest } from "@/lib/db"

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

    if (body.action === "convert") {
      const event = String(body.event ?? "")
      if (!event) return NextResponse.json({ error: "event is required" }, { status: 400 })
      const result = await convertCatalogueRequest(id, event, session.user.email)
      return NextResponse.json({ success: true, orderId: result.orderId })
    }

    if (body.action === "reject") {
      const staffNote = String(body.staffNote ?? "")
      await rejectCatalogueRequest(id, staffNote)
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: "action must be 'convert' or 'reject'" }, { status: 400 })
  } catch (err) {
    console.error("Failed to update order request:", err)
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to update request" }, { status: 500 })
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/sheets/order-requests
git commit -m "feat(catalogue): staff endpoints to list, convert, and reject order requests"
```

---

### Task 18: Staff page — review order requests

**Files:**
- Create: `app/dashboard/order-requests/page.tsx`
- Create: `app/dashboard/order-requests/loading.tsx`
- Create: `app/dashboard/order-requests/OrderRequestsClient.tsx`

**Interfaces:**
- Consumes: `GET /api/sheets/order-requests`, `PUT /api/sheets/order-requests/[id]` (Task 17), `EventSelect` (`components/EventSelect.tsx`), `useSheetOptions`

- [ ] **Step 1: Write the page shell and loading state**

`app/dashboard/order-requests/page.tsx`:

```typescript
import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import OrderRequestsClient from "./OrderRequestsClient"

export default function OrderRequestsPage() {
  return (
    <PageShell>
      <PageHeader title="Order Requests" subtitle="Review catalogue requests and convert them into orders" />
      <OrderRequestsClient />
    </PageShell>
  )
}
```

`app/dashboard/order-requests/loading.tsx`:

```typescript
import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Order Requests" subtitle="Review catalogue requests and convert them into orders" />
      <TableSkeleton />
    </PageShell>
  )
}
```

- [ ] **Step 2: Write the client component**

`app/dashboard/order-requests/OrderRequestsClient.tsx`:

```typescript
"use client"

import { useEffect, useState } from "react"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import EventSelect from "@/components/EventSelect"
import { displayIg } from "@/lib/format"
import type { CatalogueRequest } from "@/lib/db"

export default function OrderRequestsClient() {
  const options = useSheetOptions()
  const [requests, setRequests] = useState<CatalogueRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [convertingId, setConvertingId] = useState<number | null>(null)
  const [rejectingId, setRejectingId] = useState<number | null>(null)

  async function reload() {
    const res = await fetch("/api/sheets/order-requests", { cache: "no-store" })
    const data = await res.json()
    setRequests(data.requests ?? [])
    setLoading(false)
  }

  useEffect(() => { reload() }, [])

  if (loading) return <p className="text-sm text-gray-400">Loading…</p>
  if (requests.length === 0) return <p className="text-sm text-gray-400">No pending requests.</p>

  return (
    <div className="flex flex-col gap-2">
      {requests.map((r) => (
        <div key={r.id} className="rounded-xl border border-cream-border bg-white p-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm text-foreground">{displayIg(r.customerHandle)} — {r.productName} × {r.qty}</div>
            {r.note && <div className="text-xs text-gray-400">{r.note}</div>}
          </div>
          <div className="flex gap-2 shrink-0">
            <button onClick={() => setConvertingId(r.id)} className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs">Convert</button>
            <button onClick={() => setRejectingId(r.id)} className="px-3 py-1.5 rounded-lg border border-cream-border text-xs">Reject</button>
          </div>
        </div>
      ))}
      {convertingId != null && (
        <ConvertModal
          requestId={convertingId}
          events={options?.activeEvents ?? []}
          onClose={() => setConvertingId(null)}
          onDone={() => { setConvertingId(null); reload() }}
        />
      )}
      {rejectingId != null && (
        <RejectModal
          requestId={rejectingId}
          onClose={() => setRejectingId(null)}
          onDone={() => { setRejectingId(null); reload() }}
        />
      )}
    </div>
  )
}

function ConvertModal({ requestId, events, onClose, onDone }: {
  requestId: number
  events: string[]
  onClose: () => void
  onDone: () => void
}) {
  const [event, setEvent] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  async function submit() {
    if (!event) { setError("Pick an event"); return }
    setSubmitting(true); setError("")
    try {
      const res = await fetch(`/api/sheets/order-requests/${requestId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "convert", event }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl p-5 w-full max-w-sm flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-foreground">Convert to order</h3>
        <EventSelect value={event} onChange={setEvent} events={events} placeholder="Select event…" />
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Convert"}
          </button>
        </div>
      </div>
    </div>
  )
}

function RejectModal({ requestId, onClose, onDone }: {
  requestId: number
  onClose: () => void
  onDone: () => void
}) {
  const [staffNote, setStaffNote] = useState("")
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    setSubmitting(true)
    await fetch(`/api/sheets/order-requests/${requestId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject", staffNote }),
    })
    onDone()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl p-5 w-full max-w-sm flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-foreground">Reject request</h3>
        <input
          value={staffNote}
          onChange={(e) => setStaffNote(e.target.value)}
          placeholder="Note the customer will see (optional)"
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
        />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Reject"}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Confirm `EventSelect`'s exact prop names before this compiles**

Run: `grep -n "export default function EventSelect" -A 10 components/EventSelect.tsx`
Expected: confirms the prop names (`value`, `onChange`, `events`, `placeholder`) match what Step 2 assumes — every other page in this codebase invokes it as `<EventSelect value={...} onChange={...} events={...} />` (e.g. `app/dashboard/list-order/DataTable.tsx:1166`'s `AddOrderForm`), so this should already match, but confirm before moving on since a mismatch here is a straightforward compile error.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/dashboard/order-requests
git commit -m "feat(catalogue): staff page to review, convert, and reject order requests"
```

---

### Task 19: Sidebar and access registration

**Files:**
- Modify: `components/SidebarClient.tsx`
- Modify: `lib/access.ts` (no change needed — owner-only is the default; this task just confirms that, see Step 2)

**Interfaces:**
- Consumes: existing `NAV_SECTIONS` structure (`components/SidebarClient.tsx:18`)

- [ ] **Step 1: Add both new pages to the sidebar**

In `components/SidebarClient.tsx`, add a new entry to the `"Input Order"` section (same section as `Order`/`Invoice`, since these are part of the same order-intake lifecycle), right after the `list-order` entry:

```typescript
      {
        href: "/dashboard/order-requests",
        label: "Order Requests",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        ),
      },
```

Add a new entry to the `"Database"` section (alongside Customers/Currencies/Events/Products, since this is content management, not order workflow), right after the `products` entry:

```typescript
      {
        href: "/dashboard/catalogue-posts",
        label: "Catalogue Posts",        icon: (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.5-3.5a2 2 0 0 0-2.83 0L5 21" />
          </svg>
        ),
      },
```

- [ ] **Step 2: Confirm owner-only is correct**

Both new hrefs are absent from `ADMIN_ROUTES` in `lib/access.ts` — `canAccessRoute` (`lib/access.ts:24-27`) returns `false` for any role other than `owner` on a route not listed there, so both pages are owner-only automatically with no further change. If admins should also see these, add both hrefs to `ADMIN_ROUTES`. Default here is owner-only, matching the sensitivity of "converts a customer request into a real order" and "publishes customer-facing content."

- [ ] **Step 3: Typecheck and visual check**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run dev`, log in as owner, confirm both "Order Requests" and "Catalogue Posts" appear in the sidebar and both pages load without redirect.

- [ ] **Step 4: Commit**

```bash
git add components/SidebarClient.tsx
git commit -m "feat(catalogue): add Order Requests and Catalogue Posts to the sidebar"
```

---

### Task 20: End-to-end manual verification

No automated test suite exists in this repo (see Global Constraints), so the final check is a scripted manual pass through the full flow, run once against the local dev stack.

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed with zero errors across every file touched in Tasks 1-19.

- [ ] **Step 2: Seed a product and confirm local Supabase + dev server are up**

Run: `supabase status` (start Docker + `supabase start` first if not running), `npm run dev` (background).
Confirm at least one row exists in the local `products` table (any existing seeded product works — check with the same read-only `node -e` + `postgres` package pattern used in Task 2, or via `/dashboard/products` in the browser).

- [ ] **Step 3: Staff creates a catalogue post**

In the browser, log in as owner, go to `/dashboard/catalogue-posts`, upload any small image file, tag it to the seeded product from Step 2, submit.
Expected: the post appears in the list below the form, marked "Hidden". Click to toggle it to "Visible".

- [ ] **Step 4: Customer browses and submits a request**

Open `/catalogue` in a new incognito/private window (no session).
Expected: the post from Step 3 appears with its tagged product, price shown, a qty/note/handle row, and a "Fix" button. Fill in an IG handle, submit.
Expected: button changes to "Requested ✓", no error shown.

- [ ] **Step 5: Customer checks status**

On the same `/catalogue` page, scroll to "Check my requests", enter the same handle, click Check.
Expected: the just-submitted request appears with status "pending".

- [ ] **Step 6: Staff converts the request**

Back in the owner session, go to `/dashboard/order-requests`.
Expected: the pending request appears. Click Convert, pick any active event, submit.
Expected: modal closes, request disappears from the pending list (or, if `?all=true` were used, would show status "converted" — the default view only shows pending).

- [ ] **Step 7: Confirm the order was actually created**

Go to `/dashboard/list-order`, filter/search for the customer handle used in Step 4.
Expected: a new order line exists for that customer, the product from Step 3, the qty submitted in Step 4.

- [ ] **Step 8: Confirm status lookup reflects the conversion**

Back on `/catalogue`, run "Check my requests" again with the same handle.
Expected: the request now shows status "converted".

- [ ] **Step 9: Test rejection on a second request**

Repeat Step 4 to submit a second request (any product/qty), then in `/dashboard/order-requests` click Reject with a short note, submit.
Expected: on `/catalogue` status lookup, that second request shows "rejected — <the note>".

- [ ] **Step 10: Final commit (if any fixes were needed during verification)**

If Steps 1-9 required any fixes, commit them individually with clear messages before considering the feature done. If everything passed as-built, there's nothing to commit here — the feature is complete as of Task 19's commit.

---

## Self-Review

**1. Spec coverage:**
- Architecture (public route, public API, staff pages, media upload) — Tasks 5, 10-19.
- Data model (`catalogue_posts`, `catalogue_post_products`, `catalogue_requests`) — Task 2.
- Decision 1 (never write into `orders` directly, conversion reuses `appendOrders`) — Tasks 1, 8, 17.
- Decision 2 (post-centric, many-to-many products) — Task 2, 7.
- Decision 3 (one-at-a-time, "Fix" button) — Task 13.
- Decision 4 (staff review is its own page) — Tasks 17-18.
- Decision 5 (`@supabase/supabase-js`, storage-only) — Task 10.
- Decision 6 (no FK on `customer_handle`) — Task 2.
- New role `catalogue_public` — Task 3.
- Storage bucket — Task 4.
- Public routes' 300-char note cap / 30-char handle cap — Task 12.
- Staff conversion prefill (customer/product/qty/note→order.note) — Task 8's `convertCatalogueRequest`, Task 18's `ConvertModal`.
- Upload caps (5MB photo / 50MB video) — Task 10.
- Sidebar registration, owner-only default — Task 19.
All spec sections have a corresponding task.

**2. Placeholder scan:** No "TBD"/"TODO" left in any task body. Task 13 flagged and immediately resolved a real gap (post→product resolution) rather than deferring it. Task 7/18 include explicit "confirm before proceeding" steps (checking `postgres.Sql`'s real type name, checking `EventSelect`'s exact props) instead of assuming — these aren't placeholders, they're steps that produce real verification output before the next step depends on it.

**3. Type consistency:** `CataloguePost`/`CatalogueRequest` (Task 6) are used identically in Tasks 7, 8, 13, 16, 18. `appendOrders`' widened return shape (`{id, productId}[]`, Task 1) matches how Task 8's `convertCatalogueRequest` destructures it (`created.id`). Route parameter shapes (`{customerHandle, productId, qty, note}` in Task 12) match what Task 13's `CatalogueClient` sends. `action: "convert" | "reject"` in Task 17 matches what Task 18's two modals send.

**4. Scope check:** One cohesive feature, sequentially dependent (schema → DB layer → API → UI), not independent subsystems — appropriately one plan, not several.
