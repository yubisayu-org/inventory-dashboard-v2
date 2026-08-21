# Custom Order Requests (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** let a customer request something not in the catalogue (a free-text
description, optionally with a reference photo) through the same
request → staff review → convert-into-order pipeline the existing Fix
requests already use.

**Architecture:** extend the existing `catalogue_requests` table (nullable
`product_id`, new `description`/`reference_image_url` columns) rather than
building a parallel system. A new pair of public API routes handles
submission and a signed Storage-upload URL; the existing staff dashboard,
convert/reject routes, and public status-lookup route are extended with a
small branch each for the no-product case.

**Tech Stack:** Next.js route handlers, `postgres` (raw SQL, no ORM),
Supabase Storage (`createSignedUploadUrl` — verified locally to work via a
plain unauthenticated `fetch` PUT, no client-side Supabase key needed).

**Spec:** `docs/superpowers/specs/2026-08-16-custom-order-requests-design.md`

**Scope note:** this plan covers `inventory-dashboard-v2` only. The
video-catalog site's new customer-facing submission page is a separate
follow-up plan, written later in that repo, once this backend exists for it
to call.

## Global Constraints

- No RLS anywhere in this app — the `catalogue_public` role's column-scoped
  grants are the real security boundary; per-row scoping (customer handle,
  post visibility) is enforced in API route `WHERE` clauses, matching the
  pattern already established by every other public route in this codebase.
- Raw SQL via the `postgres` package only, no ORM.
- Staff routes use `requireSession`/`requireOwner` from `lib/api.ts`.
- Public routes: CORS via a fixed `ALLOWED_ORIGIN` (currently the same
  placeholder `https://yubisayu-catalogue.netlify.app` every other public
  catalogue route already uses), body-size guard before parsing, JSON parse
  errors return 400 not 500, no test framework exists — verification is
  `tsc`/`build`/manual only.
- `convertCatalogueRequest`'s existing row-locking (`FOR UPDATE` +
  status-scoped `UPDATE ... RETURNING`) is the mechanism that prevents a
  request from being double-converted — every change to that function must
  preserve it exactly.
- Reference photos: images only (no video), 5MB cap — the same cap
  `lib/storage.ts`'s existing `MAX_PHOTO_BYTES` already uses for catalogue
  post photos.

---

### Task 1: Migration — nullable product_id, description, reference photo, grant

**Files:**
- Create: `supabase/migrations/061_custom_catalogue_requests.sql`

**Interfaces:**
- Produces: the schema every later task's SQL depends on —
  `catalogue_requests.product_id` nullable, `catalogue_requests.description
  TEXT NOT NULL DEFAULT ''`, `catalogue_requests.reference_image_url TEXT`
  (nullable), plus a check constraint and an extended `catalogue_public`
  INSERT grant.

- [ ] **Step 1: Write the migration**

```sql
-- Extends catalogue_requests (migration 058) to support a "custom" request
-- that has no tagged catalogue product: a free-text description of what the
-- customer wants, with an optional reference photo, instead of a product_id.
-- See docs/superpowers/specs/2026-08-16-custom-order-requests-design.md.

ALTER TABLE catalogue_requests
  ALTER COLUMN product_id DROP NOT NULL,
  ADD COLUMN description TEXT NOT NULL DEFAULT '',
  ADD COLUMN reference_image_url TEXT;

-- A request must be one or the other: a tagged product, or a description of
-- what the customer wants. Never neither (an empty, meaningless row).
ALTER TABLE catalogue_requests
  ADD CONSTRAINT catalogue_requests_product_or_description
  CHECK (product_id IS NOT NULL OR description <> '');

-- Column-privilege GRANTs are additive in Postgres — this ADDS description
-- and reference_image_url to the INSERT column list migration 059 already
-- granted (customer_handle, product_id, qty, note); it does not need to
-- REVOKE and re-grant the existing columns.
GRANT INSERT (description, reference_image_url) ON catalogue_requests TO catalogue_public;
```

- [ ] **Step 2: Apply locally and verify**

Run: `supabase migration up` (or apply via the local Supabase Studio SQL
editor, per this repo's established local-dev workflow).

Verify the constraint works both ways:
```sql
-- Should fail (neither product_id nor description):
INSERT INTO catalogue_requests (customer_handle, qty) VALUES ('test', 1);
-- Should succeed (description only):
INSERT INTO catalogue_requests (customer_handle, qty, description) VALUES ('test', 1, 'a custom thing');
DELETE FROM catalogue_requests WHERE customer_handle = 'test';
```
Expected: the first INSERT raises a check-constraint violation naming
`catalogue_requests_product_or_description`; the second succeeds.

Verify the grant with a read-only sanity check (no need to actually connect
as `catalogue_public` — column grants were already exercised end-to-end by
the existing Fix-request flow's own e2e pass; this migration's job is just
to widen that same grant, which Postgres's `information_schema` can confirm
without a live connection):
```sql
SELECT column_name FROM information_schema.column_privileges
WHERE grantee = 'catalogue_public' AND table_name = 'catalogue_requests' AND privilege_type = 'INSERT'
ORDER BY column_name;
```
Expected: `customer_handle, description, note, product_id, qty, reference_image_url` (6 rows).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/061_custom_catalogue_requests.sql
git commit -m "feat(catalogue): allow product-less custom requests (schema)"
```

---

### Task 2: `CatalogueRequest` type update

**Files:**
- Modify: `lib/db/types.ts:580-591`

**Interfaces:**
- Consumes: nothing new.
- Produces: the widened `CatalogueRequest` interface every later task's
  TypeScript code (DB layer, API routes, dashboard UI) is checked against.

- [ ] **Step 1: Update the interface**

Replace the existing `CatalogueRequest` interface (`lib/db/types.ts:580-591`)
with:

```typescript
export interface CatalogueRequest {
  id: number
  customerHandle: string
  productId: number | null
  productName: string | null
  description: string
  referenceImageUrl: string | null
  qty: number
  note: string
  status: "pending" | "converted" | "rejected"
  staffNote: string
  convertedOrderId: number | null
  createdAt: string
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: errors in `lib/db/catalogue-requests.ts` (its `toRequest` mapper
and other functions still assume the old shape) and
`app/dashboard/order-requests/OrderRequestsClient.tsx` (assumes
`productName`/`productId` are always non-null) — this is expected and
correct at this point; Tasks 3 and 8 fix them. Confirm the errors are
specifically about those two files and about the fields this task changed
(`productId`, `productName` nullability, missing `description`/
`referenceImageUrl`), not something unrelated.

- [ ] **Step 3: Commit**

```bash
git add lib/db/types.ts
git commit -m "feat(catalogue): widen CatalogueRequest for product-less custom requests"
```

---

### Task 3: DB layer — nullable product_id, custom-request fields, convert override

**Files:**
- Modify: `lib/db/catalogue-requests.ts` (entire file)

**Interfaces:**
- Consumes: `CatalogueRequest` (Task 2), `appendOrders` (existing,
  `lib/db/orders.ts`), `withActor` (existing, `lib/db/actor.ts`),
  `normalizeId` (existing, `lib/db/helpers.ts`).
- Produces:
  - `createCatalogueRequest(data: { customerHandle: string; productId:
    number | null; qty: number; note: string; description?: string;
    referenceImageUrl?: string | null }, db: postgres.Sql): Promise<void>`
    — `productId` widened to accept `null`; `description`/
    `referenceImageUrl` new, both optional (default `""`/`null`) so the
    existing Fix-request call site
    (`app/api/public/catalogue/requests/route.ts`) needs no change.
  - `getCatalogueRequestsByHandle`, `getCatalogueRequests` — same
    signatures as today, now `LEFT JOIN` instead of `JOIN` so custom
    requests (no product row to join to) aren't silently dropped.
  - `convertCatalogueRequest(id: number, event: string, actor: string |
    null, productIdOverride?: number): Promise<{ orderId: number }>` — new
    optional 4th parameter, used only when the request's own `product_id`
    is null.
  - `rejectCatalogueRequest` — unchanged.

- [ ] **Step 1: Replace the file**

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
    productId: (r.product_id as number | null) ?? null,
    productName: (r.product_name as string | null) ?? null,
    description: r.description as string,
    referenceImageUrl: (r.reference_image_url as string | null) ?? null,
    qty: r.qty as number,
    note: r.note as string,
    status: r.status as CatalogueRequest["status"],
    staffNote: r.staff_note as string,
    convertedOrderId: (r.converted_order_id as number | null) ?? null,
    createdAt: (r.created_at as Date).toISOString(),
  }
}

/** Public path: submit one request — either a Fix request (productId set,
 *  description/referenceImageUrl omitted) or a custom request (productId
 *  null, description required — enforced by the DB check constraint, not
 *  re-validated here since the calling route already validates it).
 *  `db` must be the scoped `catalogue_public` connection — no default.
 *  Stores the handle normalized (bare lowercase, no "@"), matching every
 *  other customer handle write in this codebase. */
export async function createCatalogueRequest(
  data: {
    customerHandle: string
    productId: number | null
    qty: number
    note: string
    description?: string
    referenceImageUrl?: string | null
  },
  db: postgres.Sql,
): Promise<void> {
  await db`
    INSERT INTO catalogue_requests (customer_handle, product_id, qty, note, description, reference_image_url)
    VALUES (
      ${normalizeId(data.customerHandle)},
      ${data.productId},
      ${data.qty},
      ${data.note},
      ${data.description ?? ""},
      ${data.referenceImageUrl ?? null}
    )
  `
}

/** Public path: a handle's own requests. `db` must be the scoped
 *  `catalogue_public` connection — no default. LEFT JOIN (not JOIN) because
 *  a custom request has no product row to join to. */
export async function getCatalogueRequestsByHandle(
  handle: string,
  db: postgres.Sql,
): Promise<CatalogueRequest[]> {
  const rows = await db`
    SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
           r.description, r.reference_image_url,
           r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at
    FROM catalogue_requests r
    LEFT JOIN products p ON p.id = r.product_id
    WHERE lower(replace(r.customer_handle, '@', '')) = ${normalizeId(handle)}
    ORDER BY r.created_at DESC
  `
  return rows.map(toRequest)
}

/** Staff path. LEFT JOIN for the same reason as above. */
export async function getCatalogueRequests(
  onlyPending: boolean,
  db: DBExecutor = sql,
): Promise<CatalogueRequest[]> {
  const rows = onlyPending
    ? await db`
        SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
               r.description, r.reference_image_url,
               r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at
        FROM catalogue_requests r
        LEFT JOIN products p ON p.id = r.product_id
        WHERE r.status = 'pending'
        ORDER BY r.created_at ASC
      `
    : await db`
        SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
               r.description, r.reference_image_url,
               r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at
        FROM catalogue_requests r
        LEFT JOIN products p ON p.id = r.product_id
        ORDER BY r.created_at DESC
      `
  return rows.map(toRequest)
}

/** Converts one request into a real order. A Fix request already carries
 *  its product_id; a custom request (product_id null) requires the caller
 *  to supply productIdOverride — staff picks a real product in the Convert
 *  modal before this is called. Both cases resolve to one final productId,
 *  then snapshot that product's current price (same convention as every
 *  other order-creation path), same as before this change.
 *
 *  Race protection unchanged: the initial SELECT locks the row (`FOR
 *  UPDATE`) and the final UPDATE re-checks `status = 'pending'`, so two
 *  concurrent conversions of the same request can't both create an order —
 *  the loser's SELECT blocks until the winner commits, then sees the
 *  already-flipped status and gets zero rows, throwing before any order is
 *  created. The SELECT no longer JOINs products (product_id may be null),
 *  so the lock now covers exactly one table — simpler, not weaker. */
export async function convertCatalogueRequest(
  id: number,
  event: string,
  actor: string | null,
  productIdOverride?: number,
): Promise<{ orderId: number }> {
  return withActor(actor, async (tx) => {
    const [request] = await tx`
      SELECT customer_handle, product_id, qty, note
      FROM catalogue_requests
      WHERE id = ${id} AND status = 'pending'
      FOR UPDATE
    `
    if (!request) throw new Error("Request not found or already handled")

    const resolvedProductId = (request.product_id as number | null) ?? productIdOverride ?? null
    if (resolvedProductId === null) {
      throw new Error("A product must be selected to convert a custom request")
    }

    const [product] = await tx`SELECT price FROM products WHERE id = ${resolvedProductId}`
    if (!product) throw new Error("Selected product not found")

    const [created] = await appendOrders(
      [{
        event,
        customer: request.customer_handle as string,
        productId: resolvedProductId,
        unitPrice: product.price as number,
        unit: request.qty as number,
        note: request.note as string,
      }],
      tx,
    )

    const rows = await tx`
      UPDATE catalogue_requests
      SET status = 'converted', converted_order_id = ${created.id}, updated_at = NOW()
      WHERE id = ${id} AND status = 'pending'
      RETURNING id
    `
    if (rows.length === 0) throw new Error("Request not found or already handled")
    return { orderId: created.id }
  })
}

export async function rejectCatalogueRequest(
  id: number,
  staffNote: string,
  db: DBExecutor = sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_requests
    SET status = 'rejected', staff_note = ${staffNote}, updated_at = NOW()
    WHERE id = ${id} AND status = 'pending'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: remaining errors only in
`app/dashboard/order-requests/OrderRequestsClient.tsx` (Task 8 fixes it) —
`lib/db/catalogue-requests.ts` itself and every route file that merely
calls these functions with their existing (still-valid) argument shapes
should now be clean.

Manual DB check against the local dev stack (mirrors the existing
Fix-request e2e pattern, run from this repo's root with the local Supabase
stack and `npm run dev` up):
```bash
node -e "
const sql = require('postgres')('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
(async () => {
  const [{id}] = await sql\`INSERT INTO catalogue_requests (customer_handle, qty, description) VALUES ('e2e_task3_test', 1, 'a custom thing') RETURNING id\`;
  console.log('inserted id', id);
  const rows = await sql\`SELECT * FROM catalogue_requests WHERE id = \${id}\`;
  console.log(rows[0]);
  await sql\`DELETE FROM catalogue_requests WHERE id = \${id}\`;
  await sql.end();
})();
"
```
Expected: the row inserts and reads back with `product_id: null`,
`description: 'a custom thing'`.

- [ ] **Step 3: Commit**

```bash
git add lib/db/catalogue-requests.ts
git commit -m "feat(catalogue): support product-less custom requests in the DB layer"
```

---

### Task 4: Storage — signed upload URL for reference photos

**Files:**
- Modify: `lib/storage.ts`

**Interfaces:**
- Consumes: the existing `supabase` service-role client and `BUCKET`
  constant already defined at the top of this file (unchanged).
- Produces: `createCatalogueUploadUrl(contentType: string): Promise<{
  uploadUrl: string; publicUrl: string }>` — Task 5's route is the only
  caller.

- [ ] **Step 1: Add the function**

Add to `lib/storage.ts`, after the existing `deleteCatalogueMedia` function
(don't modify `uploadCatalogueMedia`/`deleteCatalogueMedia`/`BUCKET`/
`MAX_PHOTO_BYTES`/`MAX_VIDEO_BYTES`/the `supabase` client — all unchanged):

```typescript
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
}

/** Public path: lets an anonymous customer upload a reference photo
 *  directly to Storage via a signed URL, without ever needing a Supabase
 *  key in the browser (verified empirically: the returned uploadUrl works
 *  with a plain unauthenticated `fetch(uploadUrl, {method:'PUT', ...})` —
 *  no Authorization/apikey header required, matching Supabase's documented
 *  signed-upload-URL contract). The caller
 *  (app/api/public/catalogue/custom-upload-url/route.ts) is itself
 *  public/no-login — this function does exactly what that route needs.
 *  Images only (no video — reference photos, not catalogue post media),
 *  reusing the same MAX_PHOTO_BYTES cap uploadCatalogueMedia enforces
 *  server-side for the equivalent staff-upload case (this signed-URL path
 *  can't enforce a byte cap itself since the browser uploads directly to
 *  Storage — Storage's own per-bucket size limit, configured when the
 *  bucket was created, is the actual backstop; this cap is a documentation
 *  anchor and a future home for a stricter per-bucket policy if needed). */
export async function createCatalogueUploadUrl(
  contentType: string,
): Promise<{ uploadUrl: string; publicUrl: string }> {
  const ext = EXT_BY_CONTENT_TYPE[contentType]
  if (!ext) throw new Error("contentType must be image/jpeg, image/png, image/webp, or image/gif")

  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`

  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
  if (error) throw new Error(`Failed to create upload URL: ${error.message}`)

  const { data: publicData } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return { uploadUrl: data.signedUrl, publicUrl: publicData.publicUrl }
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: no new errors.

Manual verification against the local Supabase stack (proves the whole
signed-URL round trip, not just that the code compiles):
```bash
node --env-file=.env.development.local -e "
const { createCatalogueUploadUrl } = require('./lib/storage.ts');
" 2>&1 | head -5
```
This will fail directly (`.ts` isn't runnable by plain `node require`) —
instead verify via a quick inline reproduction using the same Supabase
client shape, since this function is a thin wrapper with no logic beyond
what Task-writing already proved works locally:
```bash
node --env-file=.env.development.local -e "
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
  const path = 'task4-verify-' + Date.now() + '.jpg';
  const { data, error } = await supabase.storage.from('catalogue-media').createSignedUploadUrl(path);
  if (error) { console.log('ERROR', error.message); return; }
  const res = await fetch(data.signedUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from([0xff, 0xd8, 0xff]) });
  console.log('PUT status:', res.status);
  const { data: pub } = supabase.storage.from('catalogue-media').getPublicUrl(path);
  console.log('publicUrl starts correctly:', pub.publicUrl.includes(path));
  await supabase.storage.from('catalogue-media').remove([path]);
})();
"
```
Expected: `PUT status: 200`, `publicUrl starts correctly: true`. This is
exactly what `createCatalogueUploadUrl` does internally — Step 4 of the
plan's final Task 9 exercises the real TypeScript function through the
actual route.

- [ ] **Step 3: Commit**

```bash
git add lib/storage.ts
git commit -m "feat(catalogue): signed upload URL for custom-request reference photos"
```

---

### Task 5: Public route — signed upload URL endpoint

**Files:**
- Create: `app/api/public/catalogue/custom-upload-url/route.ts`

**Interfaces:**
- Consumes: `createCatalogueUploadUrl` (Task 4).
- Produces: `POST /api/public/catalogue/custom-upload-url` (body:
  `{contentType: string}`) → `{uploadUrl: string, publicUrl: string}` on
  success. The video-catalog site's future submission page is the intended
  caller, but this task tests it directly with `curl`, mirroring how the
  original catalogue feature verified each public route standalone before
  a frontend existed to call it.

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from "next/server"
import { createCatalogueUploadUrl } from "@/lib/storage"

// Public, no-login endpoint for the customer-facing catalogue site to get a
// signed Storage upload URL for a reference photo on a custom request. See
// docs/superpowers/specs/2026-08-16-custom-order-requests-design.md for why
// this two-step (get a URL, then PUT the file directly to Storage) shape
// exists instead of proxying file bytes through this app or the catalogue
// site's own Netlify Functions.
//
// TODO: swap for the real domain once the catalogue site is deployed.
const ALLOWED_ORIGIN = "https://yubisayu-catalogue.netlify.app"

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() })
  }

  const contentType = String((body as Record<string, unknown>).contentType ?? "")

  try {
    const { uploadUrl, publicUrl } = await createCatalogueUploadUrl(contentType)
    return NextResponse.json({ uploadUrl, publicUrl }, { headers: corsHeaders() })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create upload URL"
    // createCatalogueUploadUrl's own "contentType must be..." message is the
    // one user-actionable case here (bad input) — everything else (Storage
    // failure, misconfiguration) is a genuine server error.
    const status = message.startsWith("contentType must be") ? 400 : 500
    console.error("Failed to create catalogue upload URL:", err)
    return NextResponse.json({ error: message }, { status, headers: corsHeaders() })
  }
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` — expect no new errors.

Run `npm run dev` (background) if not already running, then:
```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:3000/api/public/catalogue/custom-upload-url \
  -H "Content-Type: application/json" \
  -d '{"contentType":"image/png"}'
```
Expected: `200`, body `{"uploadUrl":"https://...","publicUrl":"https://..."}`.

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:3000/api/public/catalogue/custom-upload-url \
  -H "Content-Type: application/json" \
  -d '{"contentType":"application/pdf"}'
```
Expected: `400`, body `{"error":"contentType must be image/jpeg, image/png, image/webp, or image/gif"}`.

- [ ] **Step 3: Commit**

```bash
git add app/api/public/catalogue/custom-upload-url/route.ts
git commit -m "feat(catalogue): public endpoint for custom-request reference-photo upload URLs"
```

---

### Task 6: Public route — submit a custom request

**Files:**
- Create: `app/api/public/catalogue/custom-requests/route.ts`

**Interfaces:**
- Consumes: `createCatalogueRequest` (Task 3, via `@/lib/db`),
  `catalogueSql` (existing, `@/lib/db-catalogue-public`).
- Produces: `POST /api/public/catalogue/custom-requests` (body:
  `{customerHandle, description, qty, note, referenceImageUrl?}`) →
  `{success: true}` on success, matching the existing Fix-request POST's
  response shape. Kept as a separate route file from the existing
  `.../catalogue/requests` route (not a branch inside it) because the
  required fields and validation genuinely differ (`description` instead
  of `productId`).

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from "next/server"
import { createCatalogueRequest } from "@/lib/db"
import catalogueSql from "@/lib/db-catalogue-public"

// Public, no-login endpoint for submitting a custom (product-less)
// catalogue request. See
// docs/superpowers/specs/2026-08-16-custom-order-requests-design.md.
// Mirrors app/api/public/catalogue/requests/route.ts's POST validation
// shape (body-size guard, JSON parse try/catch, handle regex, CORS).
//
// TODO: swap for the real domain once the catalogue site is deployed.
const ALLOWED_ORIGIN = "https://yubisayu-catalogue.netlify.app"

const MAX_BODY_BYTES = 4 * 1024
const MAX_HANDLE_LEN = 30
const MAX_NOTE_LEN = 300
const MAX_DESCRIPTION_LEN = 500

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

export async function POST(req: NextRequest) {
  const declaredLen = Number(req.headers.get("content-length") ?? 0)
  if (declaredLen > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: corsHeaders() })
  }

  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413, headers: corsHeaders() })
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() })
  }

  // The only URL shape this endpoint accepts as a reference image — anything
  // else would make this route an open relay for arbitrary attacker-supplied
  // URLs stored in our own DB and rendered in the staff dashboard.
  const referenceImagePrefix = process.env.SUPABASE_URL
    ? `${process.env.SUPABASE_URL}/storage/v1/object/public/catalogue-media/`
    : null

  try {
    const b = body as Record<string, unknown>
    const customerHandle = String(b.customerHandle ?? "").trim()
    const description = String(b.description ?? "").trim()
    const qty = Number(b.qty)
    const note = String(b.note ?? "").trim()
    const referenceImageUrl = b.referenceImageUrl ? String(b.referenceImageUrl).trim() : null

    if (!customerHandle || customerHandle.length > MAX_HANDLE_LEN) {
      return NextResponse.json({ error: "A valid customerHandle is required" }, { status: 400, headers: corsHeaders() })
    }
    if (!/^@?[a-zA-Z0-9._]{1,30}$/.test(customerHandle)) {
      return NextResponse.json({ error: "Invalid customerHandle" }, { status: 400, headers: corsHeaders() })
    }
    if (!description || description.length > MAX_DESCRIPTION_LEN) {
      return NextResponse.json(
        { error: `description is required and must be ${MAX_DESCRIPTION_LEN} characters or fewer` },
        { status: 400, headers: corsHeaders() },
      )
    }
    if (!Number.isInteger(qty) || qty < 1) {
      return NextResponse.json({ error: "qty must be a positive integer" }, { status: 400, headers: corsHeaders() })
    }
    if (note.length > MAX_NOTE_LEN) {
      return NextResponse.json(
        { error: `note must be ${MAX_NOTE_LEN} characters or fewer` },
        { status: 400, headers: corsHeaders() },
      )
    }
    if (referenceImageUrl) {
      if (!referenceImagePrefix || !referenceImageUrl.startsWith(referenceImagePrefix)) {
        return NextResponse.json({ error: "Invalid referenceImageUrl" }, { status: 400, headers: corsHeaders() })
      }
    }

    await createCatalogueRequest(
      { customerHandle, productId: null, description, qty, note, referenceImageUrl },
      catalogueSql,
    )
    return NextResponse.json({ success: true }, { headers: corsHeaders() })
  } catch (err) {
    console.error("Failed to save custom catalogue request:", err)
    return NextResponse.json({ error: "Failed to save request" }, { status: 500, headers: corsHeaders() })
  }
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` — expect no new errors.

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:3000/api/public/catalogue/custom-requests \
  -H "Content-Type: application/json" \
  -d '{"customerHandle":"e2e_task6_test","description":"A custom bag in navy blue","qty":1,"note":""}'
```
Expected: `200 {"success":true}`.

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:3000/api/public/catalogue/custom-requests \
  -H "Content-Type: application/json" \
  -d '{"customerHandle":"e2e_task6_test","description":"","qty":1,"note":""}'
```
Expected: `400`, error mentions description is required.

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:3000/api/public/catalogue/custom-requests \
  -H "Content-Type: application/json" \
  -d '{"customerHandle":"e2e_task6_test","description":"test","qty":1,"note":"","referenceImageUrl":"https://evil.example.com/x.jpg"}'
```
Expected: `400`, `{"error":"Invalid referenceImageUrl"}`.

Clean up the first successful test row (it has no product_id, easy to spot):
```bash
node -e "
const sql = require('postgres')('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
(async () => {
  await sql\`DELETE FROM catalogue_requests WHERE customer_handle = 'e2e_task6_test'\`;
  await sql.end();
})();
"
```

- [ ] **Step 3: Commit**

```bash
git add app/api/public/catalogue/custom-requests/route.ts
git commit -m "feat(catalogue): public endpoint to submit a custom order request"
```

---

### Task 7: Staff route — convert with a product override

**Files:**
- Modify: `app/api/sheets/order-requests/[id]/route.ts`

**Interfaces:**
- Consumes: `convertCatalogueRequest` (Task 3, widened signature).
- Produces: `PUT /api/sheets/order-requests/[id]` with `{action:
  "convert", event, productId?}` — `productId` is a new optional field,
  required only when converting a custom request (no change to the
  existing Fix-request convert behavior, which never needs it).

- [ ] **Step 1: Replace the file**

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

      const productIdRaw = body.productId
      let productId: number | undefined
      if (productIdRaw !== undefined && productIdRaw !== null) {
        productId = Number(productIdRaw)
        if (!Number.isInteger(productId) || productId < 1) {
          return NextResponse.json({ error: "productId must be a positive integer" }, { status: 400 })
        }
      }

      try {
        const result = await convertCatalogueRequest(id, event, session.user.email ?? null, productId)
        return NextResponse.json({ success: true, orderId: result.orderId })
      } catch (err) {
        if (isGuardViolation(err)) return NextResponse.json({ error: err.message }, { status: 409 })
        if (isUserActionable(err)) return NextResponse.json({ error: err.message }, { status: 400 })
        throw err
      }
    }

    if (body.action === "reject") {
      const staffNote = String(body.staffNote ?? "")
      try {
        await rejectCatalogueRequest(id, staffNote)
        return NextResponse.json({ success: true })
      } catch (err) {
        if (isGuardViolation(err)) return NextResponse.json({ error: err.message }, { status: 409 })
        throw err
      }
    }

    return NextResponse.json({ error: "action must be 'convert' or 'reject'" }, { status: 400 })
  } catch (err) {
    console.error("Failed to update order request:", err)
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to update request" }, { status: 500 })
  }
}

// convertCatalogueRequest/rejectCatalogueRequest (lib/db/catalogue-requests.ts) throw this
// exact message when the request is already converted/rejected or doesn't exist — a
// user-actionable guard violation, not a server error. Matches the specific-catch treatment in
// app/api/sheets/duplicate-form/[row]/route.ts (returnOrderUnitsToExcess guard).
function isGuardViolation(err: unknown): err is Error {
  return err instanceof Error && err.message === "Request not found or already handled"
}

// convertCatalogueRequest throws these two exact messages when a custom
// request (no tagged product) is converted without staff picking one, or
// with a productId that no longer resolves to a real product — both are
// user-actionable input problems (400), distinct from the "someone else
// already handled it" race isGuardViolation covers (409).
function isUserActionable(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err.message === "A product must be selected to convert a custom request" ||
      err.message === "Selected product not found")
  )
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` — expect no new errors.

Using the request created in Task 6's verification (re-create it if already
cleaned up), find its id via the owner-session technique documented in this
branch's own prior e2e passes (deriving an `authjs.session-token` JWT
offline from `AUTH_SECRET`/`OWNER_EMAILS` — see this repo's git history for
the exact prior working example, `git log --all --grep="task-20\|task-7"`
if needed), then:

```bash
# Attempt convert WITHOUT productId (should fail — this is a custom request)
curl -s -w "\nHTTP %{http_code}\n" -X PUT http://localhost:3000/api/sheets/order-requests/<id> \
  -H "Content-Type: application/json" -b "authjs.session-token=<token>" \
  -d '{"action":"convert","event":"<a real active event value>"}'
```
Expected: `400 {"error":"A product must be selected to convert a custom request"}`.

```bash
# Convert WITH a valid productId
curl -s -w "\nHTTP %{http_code}\n" -X PUT http://localhost:3000/api/sheets/order-requests/<id> \
  -H "Content-Type: application/json" -b "authjs.session-token=<token>" \
  -d '{"action":"convert","event":"<a real active event value>","productId":2}'
```
Expected: `200 {"success":true,"orderId":<n>}`.

- [ ] **Step 3: Commit**

```bash
git add app/api/sheets/order-requests/\[id\]/route.ts
git commit -m "feat(catalogue): staff convert accepts a product override for custom requests"
```

---

### Task 8: Staff dashboard — display and convert UI

**Files:**
- Modify: `app/dashboard/order-requests/OrderRequestsClient.tsx` (entire file)

**Interfaces:**
- Consumes: `CatalogueRequest` (Task 2), `PUT /api/sheets/order-requests/[id]`
  (Task 7), `useSheetOptions()`'s `options.items: ItemOption[]` (existing,
  `lib/db/types.ts`), `SearchableSelect` (existing,
  `components/SearchableSelect.tsx`), `fmt` (existing, `lib/format.ts`).
- Produces: no later task depends on this one.

- [ ] **Step 1: Replace the file**

```tsx
"use client"

import { useEffect, useMemo, useState } from "react"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import EventSelect from "@/components/EventSelect"
import SearchableSelect from "@/components/SearchableSelect"
import { displayIg, fmt } from "@/lib/format"
import type { CatalogueRequest } from "@/lib/db"

export default function OrderRequestsClient() {
  const options = useSheetOptions()
  const [requests, setRequests] = useState<CatalogueRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [convertingId, setConvertingId] = useState<number | null>(null)
  const [rejectingId, setRejectingId] = useState<number | null>(null)

  async function reload() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/order-requests", { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to load")
      setRequests(data.requests ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() }, [])

  const converting = requests.find((r) => r.id === convertingId) ?? null

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : requests.length === 0 ? (
        <p className="text-sm text-gray-400">No pending requests.</p>
      ) : (
        requests.map((r) => (
          <div key={r.id} className="rounded-xl border border-cream-border bg-white p-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {r.referenceImageUrl && (
                <a href={r.referenceImageUrl} target="_blank" rel="noopener noreferrer" className="shrink-0">
                  <img src={r.referenceImageUrl} alt="" className="w-10 h-10 rounded-lg object-cover border border-cream-border" />
                </a>
              )}
              <div>
                <div className="text-sm text-foreground">
                  {displayIg(r.customerHandle)} —{" "}
                  {r.productName ? (
                    <>{r.productName} × {r.qty}</>
                  ) : (
                    <>
                      <span className="inline-block px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-medium mr-1 align-middle">Custom</span>
                      {r.description} × {r.qty}
                    </>
                  )}
                </div>
                {r.note && <div className="text-xs text-gray-400">{r.note}</div>}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => setConvertingId(r.id)} className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs">Convert</button>
              <button onClick={() => setRejectingId(r.id)} className="px-3 py-1.5 rounded-lg border border-cream-border text-xs">Reject</button>
            </div>
          </div>
        ))
      )}
      {converting && (
        <ConvertModal
          requestId={converting.id}
          needsProduct={converting.productId === null}
          events={options?.activeEvents ?? []}
          items={options?.items ?? []}
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

function ConvertModal({ requestId, needsProduct, events, items, onClose, onDone }: {
  requestId: number
  needsProduct: boolean
  events: string[]
  items: { id: number; name: string; store: string; price: number; active: boolean }[]
  onClose: () => void
  onDone: () => void
}) {
  const [event, setEvent] = useState("")
  const [productId, setProductId] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  const itemOptions = useMemo(
    () => items.filter((it) => it.active).map((it) => ({
      value: String(it.id),
      label: it.name,
      meta: `Rp ${fmt(it.price)}`,
    })),
    [items],
  )

  async function submit() {
    if (!event) { setError("Pick an event"); return }
    if (needsProduct && !productId) { setError("Pick a product for this custom request"); return }
    setSubmitting(true); setError("")
    try {
      const res = await fetch(`/api/sheets/order-requests/${requestId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "convert",
          event,
          ...(needsProduct ? { productId: Number(productId) } : {}),
        }),
      })
      const data = await res.json()
      // 409 = someone else already converted/rejected this request (guard
      // violation); 400 = validation problem (missing event, or a custom
      // request converted without picking a product). Surfaced identically
      // via the same error message, both are user-actionable, not crashes.
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
        {needsProduct && (
          <SearchableSelect
            value={productId}
            onChange={setProductId}
            options={itemOptions}
            placeholder="Search product for this custom request…"
          />
        )}
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
  const [error, setError] = useState("")

  async function submit() {
    setSubmitting(true); setError("")
    try {
      const res = await fetch(`/api/sheets/order-requests/${requestId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", staffNote }),
      })
      const data = await res.json()
      // Same 409-on-guard-violation handling as ConvertModal above.
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
        <h3 className="text-sm font-semibold text-foreground">Reject request</h3>
        <input
          value={staffNote}
          onChange={(e) => setStaffNote(e.target.value)}
          placeholder="Note the customer will see (optional)"
          className="border border-cream-border rounded-lg px-2 py-1.5 text-sm"
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
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

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npm run build` — both must be clean, and this
should now be the LAST file with errors from Task 2's widening — confirm
zero TypeScript errors anywhere in the project at this point.

- [ ] **Step 3: Commit**

```bash
git add app/dashboard/order-requests/OrderRequestsClient.tsx
git commit -m "feat(catalogue): staff UI for reviewing and converting custom requests"
```

---

### Task 9: End-to-end verification

No automated test suite exists — this is a full manual pass through the
whole custom-request flow against the local dev stack, mirroring this
branch's own prior e2e passes.

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed with zero errors.

- [ ] **Step 2: Confirm local stack is up**

`supabase status` (start if needed), `npm run dev` (background if not
already running). Confirm at least one active event exists (needed for
Step 6) and note a real product id/price to convert against (e.g. the
`NUMBUZIN...` product, id 2, used in this branch's own prior e2e passes).

- [ ] **Step 3: Get an upload URL and upload a reference photo**

```bash
curl -s -X POST http://localhost:3000/api/public/catalogue/custom-upload-url \
  -H "Content-Type: application/json" -d '{"contentType":"image/png"}'
```
Note the `uploadUrl` and `publicUrl` from the response. Upload a tiny real
PNG to it:
```bash
curl -s -w "\nHTTP %{http_code}\n" -X PUT "<uploadUrl from above>" \
  -H "Content-Type: image/png" \
  --data-binary @- <<< "$(printf '\x89PNG\r\n\x1a\n')"
```
Expected: `200`.

- [ ] **Step 4: Submit the custom request**

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:3000/api/public/catalogue/custom-requests \
  -H "Content-Type: application/json" \
  -d '{"customerHandle":"e2e_task9_test","description":"A custom keychain, pastel colors","qty":2,"note":"any pastel is fine","referenceImageUrl":"<publicUrl from Step 3>"}'
```
Expected: `200 {"success":true}`.

- [ ] **Step 5: Confirm status lookup shows it correctly**

```bash
curl -s "http://localhost:3000/api/public/catalogue/requests?handle=e2e_task9_test"
```
Expected: one request, `productId: null`, `productName: null`,
`description: "A custom keychain, pastel colors"`, `status: "pending"`,
`referenceImageUrl` matching Step 3's `publicUrl`.

- [ ] **Step 6: Staff sees and converts it in the dashboard**

Log in as owner, go to `/dashboard/order-requests`. Expected: the request
shows the "Custom" badge, the description text, and the reference-photo
thumbnail (click it — opens the actual uploaded image in a new tab).
Click Convert: expected the modal now also shows a product search field
(not just the event picker). Try submitting with only an event picked —
expected a "Pick a product for this custom request" validation message,
no request sent. Pick a real product, pick an event, submit. Expected:
modal closes, request disappears from the pending list.

- [ ] **Step 7: Confirm the order was created correctly**

Go to `/dashboard/list-order`, search for `e2e_task9_test`. Expected: a
new order line, the product picked in Step 6, qty 2, unit price matching
that product's current price (not 0, not a stale price).

- [ ] **Step 8: Confirm status lookup reflects the conversion**

Re-run Step 5's curl. Expected: `status: "converted"`, `convertedOrderId`
matching Step 7's order id.

- [ ] **Step 9: Test the rejection path**

Submit a second custom request (Step 4's curl, different handle, no
reference photo this time — confirm `referenceImageUrl` omission works,
not just presence). Reject it in the dashboard with a note. Re-run the
status lookup for that handle. Expected: `status: "rejected"`, `staffNote`
matches what was entered.

- [ ] **Step 10: Clean up test data and commit any fixes**

Local dev DB only — test rows can be left or deleted at your discretion
(they don't affect anything). If any step required a code fix, commit it
individually with a clear message. If everything passed as-built, nothing
to commit — the backend is complete as of Task 8's commit.

---

## Self-Review

**1. Spec coverage:** Data model (nullable `product_id`, `description`,
`reference_image_url`, check constraint, extended grant) — Task 1. Signed
upload URL flow — Tasks 4-5, empirically verified against the local stack
before this plan was written (not just assumed). Public submit endpoint,
including the anti-open-relay `referenceImageUrl` prefix check — Task 6.
Staff dashboard changes (list display, convert-time product picker,
`convertCatalogueRequest`'s override parameter) — Tasks 3, 7, 8. All spec
sections have a corresponding task. The video-catalog frontend page is
explicitly out of scope for this plan per the spec's own repo-boundary
note.

**2. Placeholder scan:** No "TBD"/"TODO" in any task body (the two `//
TODO: swap for the real domain` comments are copied verbatim from the
existing, already-shipped sibling routes' own convention — not a plan
placeholder, a real and intentional deferred-value marker matching
established code style).

**3. Type consistency:** `CatalogueRequest` (Task 2) — `productId: number
| null`, `productName: string | null`, `description: string`,
`referenceImageUrl: string | null` — used identically in Task 3's
`toRequest` mapper, Task 7's route (via `convertCatalogueRequest`'s return
type, unchanged), and Task 8's UI (`r.productId === null` gates
`needsProduct`, `r.productName` gates the display branch, `r.description`/
`r.referenceImageUrl` rendered directly). `convertCatalogueRequest`'s
`productIdOverride?: number` (Task 3) matches exactly how Task 7's route
computes and passes `productId` (also `number | undefined`, never
`null` — the route normalizes `null`/`undefined` from the request body to
`undefined` before calling). `createCatalogueRequest`'s widened data
param (Task 3) matches exactly how Task 6's route calls it
(`productId: null, description, referenceImageUrl` — all present) and how
the existing, unmodified Fix-request route still calls it (`productId`
number, `description`/`referenceImageUrl` omitted, both optional with
safe defaults — verified this needs no change to that file).

**4. Scope check:** One cohesive backend change (schema → DB layer →
public API → staff UI), sequentially dependent, appropriately one plan.
The video-catalog frontend counterpart is correctly deferred to its own
plan in its own repo, per the spec's explicit scope note and this plan's
own header.
