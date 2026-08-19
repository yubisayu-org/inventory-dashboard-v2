# Custom Request Edit & Approval (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** let the owner revise a pending custom request's country/valas/gram
(price re-estimates), require the customer to approve that revision before
it can be converted, and — once approved — let the owner one-click-create a
real product whose price is locked to exactly what the customer approved.

**Architecture:** four new nullable columns on `catalogue_requests`
(`country_id`, `valas`, `gram`, `estimated_price`), two new `status` values
(`offer_pending`, `approved`), two new owner-authenticated actions on the
existing `PUT /api/sheets/order-requests/[id]` route, one new owner-only
read-only price-preview route, two new public routes for the customer's
approve/reject, and owner-side UI additions to `OrderRequestsClient.tsx`.
No new tables, no changes to `lib/pricing.ts` or the `events` table.

**Tech Stack:** Next.js App Router, Postgres (`postgres.js`), existing
`lib/pricing.ts` (`calcAbroadPrice`), existing `catalogue_public` DB role.

**Spec:** `docs/superpowers/specs/2026-08-17-custom-request-edit-approval-design.md`

## Global Constraints

- Owner-only for every new owner-side capability — same `requireOwner()`
  pattern already used by every route under `/api/sheets/order-requests`.
- Editable fields are exactly `country_id`/`valas`/`gram` — no qty/note/
  description editing, per the spec.
- `estimated_price` is computed with `calcAbroadPrice`, fixed 15% profit,
  zero operational/packing fees, flat `roundTo = 1000` — NOT the public
  customer-facing estimator's relative-precision rounding (that hardening
  exists only because the public estimator is an unauthenticated,
  repeatedly-queryable oracle; every route in this plan is either
  owner-authenticated or a one-shot guarded state transition with nothing
  computed to leak).
- State machine: `pending` → (owner edits) → `offer_pending` → (customer
  approves) → `approved` → (owner) → `converted`/`rejected`. Customer
  rejecting a revision → `rejected` directly (terminal). Owner can
  `cancel-edit` from `offer_pending` back to `pending`. `convert`/`reject`
  are valid from `pending` OR `approved`, never from `offer_pending`.
- No history table — re-editing while `offer_pending` overwrites the same
  four columns in place.
- This plan does NOT touch `post_id`/highlights — that's a separate,
  unrelated spec/plan (`2026-08-17-catalogue-highlights-design.md`).
- Out of scope for this plan: the customer-facing approve/reject UI and the
  video-catalog Netlify proxies — separate plan, other repo.

---

### Task 1: Migration — new columns, widened status, updated grants

**Files:**
- Create: `supabase/migrations/064_custom_request_edit_approval.sql`

**Interfaces:**
- Produces: `catalogue_requests.country_id` (`INTEGER REFERENCES
  countries(id) ON DELETE SET NULL`), `.valas` (`NUMERIC`), `.gram`
  (`NUMERIC`), `.estimated_price` (`INTEGER`) — all nullable. `status` CHECK
  now allows `'pending' | 'offer_pending' | 'approved' | 'converted' |
  'rejected'`. `catalogue_public` gains `SELECT` on the four new columns and
  a narrow `UPDATE (status)` privilege.

- [ ] **Step 1: Write the migration**

```sql
-- Custom request edit & customer-approval flow (see
-- docs/superpowers/specs/2026-08-17-custom-request-edit-approval-design.md).
-- Owner can revise a pending custom request's country/valas/gram, which
-- re-estimates a price and requires the customer to approve it before the
-- owner can convert. Four new nullable columns carry the proposed/approved
-- offer; no history table, re-editing overwrites them in place.

ALTER TABLE catalogue_requests
  ADD COLUMN country_id INTEGER REFERENCES countries(id) ON DELETE SET NULL,
  ADD COLUMN valas NUMERIC,
  ADD COLUMN gram NUMERIC,
  ADD COLUMN estimated_price INTEGER;

ALTER TABLE catalogue_requests DROP CONSTRAINT catalogue_requests_status_check;
ALTER TABLE catalogue_requests ADD CONSTRAINT catalogue_requests_status_check
  CHECK (status IN ('pending', 'offer_pending', 'approved', 'converted', 'rejected'));

-- catalogue_public already has SELECT on a fixed column list (migration 058)
-- and INSERT (migration 059) on this table for the public submit/status-lookup
-- routes. Extend the SELECT list to the four new columns — the two new public
-- routes (approve/reject) need to read status for their guard, and the
-- existing public status-lookup GET needs to surface the offer to the
-- customer. Idempotent regardless of prior grant state, same discipline as
-- migration 063.
REVOKE SELECT ON catalogue_requests FROM catalogue_public;
GRANT SELECT (
  id, customer_handle, product_id, description, reference_image_url,
  qty, note, status, staff_note, converted_order_id, created_at,
  country_id, valas, gram, estimated_price
) ON catalogue_requests TO catalogue_public;

-- New: the public approve/reject routes need to flip status themselves.
-- Scoped to exactly that one column — every other write path (create) stays
-- INSERT-only, and the app-level guarded UPDATE (WHERE status =
-- 'offer_pending' AND customer_handle = ...) is what actually enforces which
-- transition is legal, not the grant alone.
GRANT UPDATE (status, updated_at) ON catalogue_requests TO catalogue_public;
```

- [ ] **Step 2: Apply the migration**

Per this repo's established workflow (see `project_migration_workflow`
memory — migrations are applied manually in the Supabase SQL editor as the
`postgres` owner role, the app role cannot run DDL): open the local dev
Supabase SQL editor and run the migration file's contents. Confirm no
error.

- [ ] **Step 3: Verify**

```bash
psql "$DATABASE_URL" -c "\d catalogue_requests" | grep -E "country_id|valas|gram|estimated_price"
psql "$DATABASE_URL" -c "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'catalogue_requests_status_check'"
psql "$DATABASE_URL" -c "SELECT grantee, privilege_type, column_name FROM information_schema.column_privileges WHERE table_name = 'catalogue_requests' AND grantee = 'catalogue_public' ORDER BY column_name"
```

Expected: the four new columns exist; the CHECK lists all five statuses;
`catalogue_public` shows `SELECT` on all fifteen listed columns plus
`UPDATE` on `status`/`updated_at`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/064_custom_request_edit_approval.sql
git commit -m "feat(catalogue): schema for custom-request edit and customer approval"
```

---

### Task 2: Data layer — edit/cancel-edit, widened convert/reject guards, extended reads

**Files:**
- Modify: `lib/db/catalogue-requests.ts`
- Modify: `lib/db/types.ts:580-593` (`CatalogueRequest` interface)
- Modify: `lib/db/catalog.ts` (add one small helper, see Step 1)

**Interfaces:**
- Consumes: `calcAbroadPrice` from `lib/pricing.ts` (unmodified, already
  used identically by `app/api/public/catalogue/estimate-price/route.ts`).
- Produces: `editCatalogueRequest(id, {countryId, valas, gram}, db?):
  Promise<{estimatedPrice: number}>`, `cancelEditCatalogueRequest(id, db?):
  Promise<void>`, `getCountryRate(countryId, db?): Promise<{kurs: number,
  cargoPerKg: number} | null>` (new small helper in `catalog.ts`, shared by
  this task and Task 4's preview route so the kurs/cargoPerKg lookup query
  isn't duplicated). `convertCatalogueRequest`/`rejectCatalogueRequest`'s
  guard widens from `status = 'pending'` to `status IN ('pending',
  'approved')`. Task 3's route calls all four functions by these exact
  names.

- [ ] **Step 1: Add the shared country-rate helper**

In `lib/db/catalog.ts`, near the existing `getCountries()` (around line
684):

```typescript
/** One country's kurs/cargoPerKg for a server-side price computation —
 *  the single-row counterpart to getCountries()'s full list. Used by the
 *  custom-request edit/preview-price paths, both of which need only one
 *  country's rate, not the whole dropdown list. */
export async function getCountryRate(
  countryId: number,
  db: DBExecutor = sql,
): Promise<{ kurs: number; cargoPerKg: number } | null> {
  const [row] = await db`SELECT kurs, cargo_per_kg FROM countries WHERE id = ${countryId}`
  if (!row) return null
  // kurs is NUMERIC(12,4) — postgres-js returns it as a string, so coerce,
  // same as getCountries() above.
  return { kurs: Number(row.kurs) || 0, cargoPerKg: (row.cargo_per_kg as number) ?? 0 }
}
```

`DBExecutor` is already imported at the top of `catalog.ts`
(`import type { DBExecutor } from "./actor"`, line 3) — no new import
needed for this helper.

No separate export step needed — `lib/db.ts` (the barrel file `@/lib/db`
resolves to) re-exports this file with `export * from "./db/catalog"`
(line 10), so `getCountryRate` becomes available from `@/lib/db`
automatically once added here.

- [ ] **Step 2: Update the `CatalogueRequest` type**

In `lib/db/types.ts`, replace the existing interface (currently at
lines 580-593):

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
  status: "pending" | "offer_pending" | "approved" | "converted" | "rejected"
  staffNote: string
  convertedOrderId: number | null
  createdAt: string
  countryId: number | null
  countryName: string | null
  valas: number | null
  gram: number | null
  estimatedPrice: number | null
}
```

- [ ] **Step 3: Update `toRequest`, the two read functions, and add edit/cancel-edit**

In `lib/db/catalogue-requests.ts`, replace `toRequest` (lines 9-24):

```typescript
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
    countryId: (r.country_id as number | null) ?? null,
    countryName: (r.country_name as string | null) ?? null,
    // valas/gram are NUMERIC — postgres-js returns them as strings when
    // set, same coercion needed as everywhere else NUMERIC is read.
    valas: r.valas != null ? Number(r.valas) : null,
    gram: r.gram != null ? Number(r.gram) : null,
    estimatedPrice: (r.estimated_price as number | null) ?? null,
  }
}
```

Replace `getCatalogueRequestsByHandle` (lines 60-74) and
`getCatalogueRequests` (lines 77-100) to also `LEFT JOIN countries` and
select the new columns — both currently `LEFT JOIN products p`, add a
second `LEFT JOIN countries c ON c.id = r.country_id`:

```typescript
export async function getCatalogueRequestsByHandle(
  handle: string,
  db: postgres.Sql,
): Promise<CatalogueRequest[]> {
  const rows = await db`
    SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
           r.description, r.reference_image_url,
           r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at,
           r.country_id, c.name AS country_name, r.valas, r.gram, r.estimated_price
    FROM catalogue_requests r
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN countries c ON c.id = r.country_id
    WHERE lower(replace(r.customer_handle, '@', '')) = ${normalizeId(handle)}
    ORDER BY r.created_at DESC
  `
  return rows.map(toRequest)
}

export async function getCatalogueRequests(
  onlyPending: boolean,
  db: DBExecutor = sql,
): Promise<CatalogueRequest[]> {
  const rows = onlyPending
    ? await db`
        SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
               r.description, r.reference_image_url,
               r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at,
               r.country_id, c.name AS country_name, r.valas, r.gram, r.estimated_price
        FROM catalogue_requests r
        LEFT JOIN products p ON p.id = r.product_id
        LEFT JOIN countries c ON c.id = r.country_id
        WHERE r.status IN ('pending', 'offer_pending', 'approved')
        ORDER BY r.created_at ASC
      `
    : await db`
        SELECT r.id, r.customer_handle, r.product_id, p.name AS product_name,
               r.description, r.reference_image_url,
               r.qty, r.note, r.status, r.staff_note, r.converted_order_id, r.created_at,
               r.country_id, c.name AS country_name, r.valas, r.gram, r.estimated_price
        FROM catalogue_requests r
        LEFT JOIN products p ON p.id = r.product_id
        LEFT JOIN countries c ON c.id = r.country_id
        ORDER BY r.created_at DESC
      `
  return rows.map(toRequest)
}
```

Note the `onlyPending` branch's `WHERE` widened from `status = 'pending'`
to `status IN ('pending', 'offer_pending', 'approved')` — the Order
Requests page's default view must keep showing a request while it's mid
negotiation or awaiting conversion, not just in the original `pending`
state. `onlyPending` as a parameter name is now slightly imprecise (it
means "still actionable," not literally `status = 'pending'`) — leave the
name as-is, this task's scope is behavior not a rename, but note it in the
task's commit message so it isn't mistaken for an oversight.

Add two new imports to the top of the file, alongside the existing ones
(after the existing `import type { CatalogueRequest } from "./types"`
line):

```typescript
import { calcAbroadPrice } from "../pricing"
import { getCountryRate } from "./catalog"
```

Then add two new functions after `rejectCatalogueRequest` (end of file,
after line 174):

```typescript
const EDIT_PROFIT_PCT = 15
const EDIT_ROUND_TO = 1000

/** Owner-only: propose (or re-propose) a country/valas/gram revision on a
 *  pending custom request. Computes estimated_price server-side from the
 *  country's real kurs/cargoPerKg — fixed 15% margin, no fees, flat
 *  roundTo = 1000 (NOT the public estimator's relative-precision rounding;
 *  see this plan's Global Constraints for why that distinction matters
 *  here). Guarded: only from 'pending', moves to 'offer_pending'. Also
 *  covers re-editing while already offer_pending (WHERE allows both, see
 *  below) — overwrites the prior proposal in place, no history kept. */
export async function editCatalogueRequest(
  id: number,
  data: { countryId: number; valas: number; gram: number },
  db: DBExecutor = sql,
): Promise<{ estimatedPrice: number }> {
  const rate = await getCountryRate(data.countryId, db)
  if (!rate) throw new Error("Country not found")

  const { price } = calcAbroadPrice({
    valas: data.valas,
    kurs: rate.kurs,
    gram: data.gram,
    cargoPerKg: rate.cargoPerKg,
    profitPct: EDIT_PROFIT_PCT,
    operationalFee: 0,
    packingFee: 0,
    roundTo: EDIT_ROUND_TO,
  })

  const rows = await db`
    UPDATE catalogue_requests
    SET country_id = ${data.countryId}, valas = ${data.valas}, gram = ${data.gram},
        estimated_price = ${price}, status = 'offer_pending', updated_at = NOW()
    WHERE id = ${id} AND status IN ('pending', 'offer_pending')
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
  return { estimatedPrice: price }
}

/** Owner-only: withdraw a proposed revision that hasn't been answered yet
 *  (e.g. a typo) without asking the customer to reject it. Clears the four
 *  offer columns and returns to 'pending'. */
export async function cancelEditCatalogueRequest(
  id: number,
  db: DBExecutor = sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_requests
    SET country_id = NULL, valas = NULL, gram = NULL, estimated_price = NULL,
        status = 'pending', updated_at = NOW()
    WHERE id = ${id} AND status = 'offer_pending'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
}
```

Widen `convertCatalogueRequest`'s guard (both the initial `SELECT ... FOR
UPDATE` and the final `UPDATE`, currently `status = 'pending'` at lines 126
and 154) and `rejectCatalogueRequest`'s guard (currently `status =
'pending'` at line 170) to `status IN ('pending', 'approved')`:

```typescript
// convertCatalogueRequest — both occurrences:
      WHERE id = ${id} AND status IN ('pending', 'approved')
      FOR UPDATE
// ... and:
      WHERE id = ${id} AND status IN ('pending', 'approved')
      RETURNING id

// rejectCatalogueRequest:
    WHERE id = ${id} AND status IN ('pending', 'approved')
    RETURNING id
```

- [ ] **Step 4: Manual verification**

```bash
npx tsc --noEmit
```

Expected: no errors. This confirms the module compiles and the exported
names/types (`editCatalogueRequest`, `cancelEditCatalogueRequest`,
`getCountryRate`, the widened `CatalogueRequest` type) line up with what
Task 3 and Task 4 expect. Full behavioral verification happens once Task 3
wires these into a route.

- [ ] **Step 5: Commit**

```bash
git add lib/db/catalogue-requests.ts lib/db/types.ts lib/db/catalog.ts
git commit -m "feat(catalogue): edit/cancel-edit data layer for custom requests"
```

---

### Task 3: Owner route — edit/cancel-edit actions, widened convert/reject

**Files:**
- Modify: `app/api/sheets/order-requests/[id]/route.ts`

**Interfaces:**
- Consumes: `editCatalogueRequest`, `cancelEditCatalogueRequest` from
  `@/lib/db` (Task 2).
- Produces: `PUT /api/sheets/order-requests/[id]` now accepts `action:
  "edit" | "cancel-edit"` in addition to the existing `"convert"`/
  `"reject"`. Task 6's Edit/Cancel UI calls this exact contract.

- [ ] **Step 1: Add the import and two new action branches**

Add `editCatalogueRequest, cancelEditCatalogueRequest` to the existing
import from `@/lib/db` (line 3):

```typescript
import { convertCatalogueRequest, rejectCatalogueRequest, editCatalogueRequest, cancelEditCatalogueRequest } from "@/lib/db"
```

Insert two new `if (body.action === ...)` branches before the final
`return NextResponse.json({ error: "action must be..." })` (currently line
56), and update that error message:

```typescript
    if (body.action === "edit") {
      const countryId = Number(body.countryId)
      const valas = Number(body.valas)
      const gram = Number(body.gram)
      if (!Number.isInteger(countryId) || countryId < 1) {
        return NextResponse.json({ error: "countryId must be a positive integer" }, { status: 400 })
      }
      if (!Number.isFinite(valas) || valas <= 0) {
        return NextResponse.json({ error: "valas must be a positive number" }, { status: 400 })
      }
      if (!Number.isFinite(gram) || gram <= 0) {
        return NextResponse.json({ error: "gram must be a positive number" }, { status: 400 })
      }
      try {
        const result = await editCatalogueRequest(id, { countryId, valas, gram })
        return NextResponse.json({ success: true, estimatedPrice: result.estimatedPrice })
      } catch (err) {
        if (isGuardViolation(err)) return NextResponse.json({ error: err.message }, { status: 409 })
        if (err instanceof Error && err.message === "Country not found") {
          return NextResponse.json({ error: err.message }, { status: 400 })
        }
        throw err
      }
    }

    if (body.action === "cancel-edit") {
      try {
        await cancelEditCatalogueRequest(id)
        return NextResponse.json({ success: true })
      } catch (err) {
        if (isGuardViolation(err)) return NextResponse.json({ error: err.message }, { status: 409 })
        throw err
      }
    }

    return NextResponse.json({ error: "action must be 'convert', 'reject', 'edit', or 'cancel-edit'" }, { status: 400 })
```

- [ ] **Step 2: Manual verification**

With the dev server running (`npm run dev`) and a real pending custom
request id (create one via the already-shipped
`POST /api/public/catalogue/custom-requests` flow, or use an existing one
from local dev data) and a real session cookie (see this repo's existing
convention for testing owner routes locally — check `CLAUDE.md`/`AGENTS.md`
or a prior task's verification steps in this same worktree's git history
for how a dev session JWT is obtained; do not print the actual token value
in your output):

```bash
curl -s -X PUT "http://localhost:3001/api/sheets/order-requests/<id>" \
  -H "Content-Type: application/json" \
  -H "Cookie: <session-cookie>" \
  -d '{"action":"edit","countryId":1,"valas":100,"gram":500}'
```

Expected: `{"success":true,"estimatedPrice":<number>}`. Then confirm the
request now shows `status: "offer_pending"` via
`GET /api/sheets/order-requests?all=true`. Then:

```bash
curl -s -X PUT "http://localhost:3001/api/sheets/order-requests/<id>" \
  -H "Content-Type: application/json" \
  -H "Cookie: <session-cookie>" \
  -d '{"action":"cancel-edit"}'
```

Expected: `{"success":true}`, and the request's `status` back to
`"pending"`, `country_id`/`valas`/`gram`/`estimated_price` all `null`
again.

- [ ] **Step 3: Commit**

```bash
git add app/api/sheets/order-requests/[id]/route.ts
git commit -m "feat(catalogue): edit/cancel-edit actions on the order-requests route"
```

---

### Task 4: Owner-only price-preview route

**Files:**
- Create: `app/api/sheets/order-requests/preview-price/route.ts`

**Interfaces:**
- Consumes: `getCountryRate` (Task 2), `calcAbroadPrice` from `@/lib/pricing`.
- Produces: `GET /api/sheets/order-requests/preview-price?countryId=&valas=&gram=`
  → `{estimatedPrice: number}`. Task 6's Edit modal calls this as the owner
  types, debounced client-side (no debounce/rate-limit needed server-side —
  this is owner-authenticated, side-effect-free, and the existing
  `requireSession`/`requireOwner` gate is the only control it needs, same
  as every other read-only `/api/sheets/*` route in this codebase).

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { getCountryRate } from "@/lib/db"
import { calcAbroadPrice } from "@/lib/pricing"

const PROFIT_PCT = 15
const ROUND_TO = 1000

// Owner-only, read-only, side-effect-free live preview for the Edit modal —
// the same computation editCatalogueRequest (lib/db/catalogue-requests.ts)
// performs when actually submitting, exposed here so the owner sees the
// price before committing to an offer_pending state.
export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const params = req.nextUrl.searchParams
  const countryId = Number(params.get("countryId"))
  const valas = Number(params.get("valas"))
  const gram = Number(params.get("gram"))

  if (!Number.isInteger(countryId) || countryId < 1) {
    return NextResponse.json({ error: "countryId must be a positive integer" }, { status: 400 })
  }
  if (!Number.isFinite(valas) || valas <= 0) {
    return NextResponse.json({ error: "valas must be a positive number" }, { status: 400 })
  }
  if (!Number.isFinite(gram) || gram <= 0) {
    return NextResponse.json({ error: "gram must be a positive number" }, { status: 400 })
  }

  try {
    const rate = await getCountryRate(countryId)
    if (!rate) return NextResponse.json({ error: "Country not found" }, { status: 400 })

    const { price } = calcAbroadPrice({
      valas, kurs: rate.kurs, gram, cargoPerKg: rate.cargoPerKg,
      profitPct: PROFIT_PCT, operationalFee: 0, packingFee: 0, roundTo: ROUND_TO,
    })
    return NextResponse.json({ estimatedPrice: price }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to preview price:", err)
    return NextResponse.json({ error: "Failed to preview price" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Manual verification**

```bash
curl -s "http://localhost:3001/api/sheets/order-requests/preview-price?countryId=1&valas=100&gram=500" \
  -H "Cookie: <session-cookie>"
```

Expected: `{"estimatedPrice":<number>}`, and that number matches what
Task 3's `"edit"` action returns for the same inputs (same formula,
same country). Then confirm no session → 401:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://localhost:3001/api/sheets/order-requests/preview-price?countryId=1&valas=100&gram=500"
```

Expected: `401`.

- [ ] **Step 3: Commit**

```bash
git add app/api/sheets/order-requests/preview-price/route.ts
git commit -m "feat(catalogue): owner-only live price preview for the Edit modal"
```

---

### Task 5: Public approve/reject routes + extended status-lookup response

**Files:**
- Create: `app/api/public/catalogue/requests/[id]/approve/route.ts`
- Create: `app/api/public/catalogue/requests/[id]/reject/route.ts`
- Modify: `lib/db/catalogue-requests.ts` (two new public-path functions)
- Modify: `app/api/public/catalogue/requests/route.ts` (response already
  includes the new `CatalogueRequest` fields automatically via Task 2's
  `toRequest`/query changes — this step only needs review, not new code,
  see Step 3)

**Interfaces:**
- Consumes: `postgres.Sql` typed `db` param, same convention as
  `createCatalogueRequest`/`getCatalogueRequestsByHandle`.
- Produces: `POST /api/public/catalogue/requests/[id]/approve` and
  `POST /api/public/catalogue/requests/[id]/reject`, both body
  `{customerHandle}` → `{success: true}` (200), `{error}` (400/404/409).

- [ ] **Step 1: Add the two public-path functions**

In `lib/db/catalogue-requests.ts`, after `cancelEditCatalogueRequest`:

```typescript
/** Public path: customer approves a revised offer. `db` must be the
 *  scoped `catalogue_public` connection (has UPDATE(status) only, per
 *  migration 064 — this function never sets any other column). Guarded on
 *  both the id AND the handle, so one customer can't approve/reject
 *  another's offer by guessing an id — the handle is exactly as visible
 *  to the customer as the id is (both come back from the same status
 *  lookup response), so this isn't a stronger trust boundary than the
 *  rest of this feature already relies on. */
export async function approveCatalogueRequestOffer(
  id: number,
  customerHandle: string,
  db: postgres.Sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_requests
    SET status = 'approved', updated_at = NOW()
    WHERE id = ${id}
      AND lower(replace(customer_handle, '@', '')) = ${normalizeId(customerHandle)}
      AND status = 'offer_pending'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
}

/** Public path: customer rejects a revised offer — terminal, same as a
 *  staff reject. */
export async function rejectCatalogueRequestOffer(
  id: number,
  customerHandle: string,
  db: postgres.Sql,
): Promise<void> {
  const rows = await db`
    UPDATE catalogue_requests
    SET status = 'rejected', updated_at = NOW()
    WHERE id = ${id}
      AND lower(replace(customer_handle, '@', '')) = ${normalizeId(customerHandle)}
      AND status = 'offer_pending'
    RETURNING id
  `
  if (rows.length === 0) throw new Error("Request not found or already handled")
}
```

- [ ] **Step 2: Write the two public routes**

`app/api/public/catalogue/requests/[id]/approve/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server"
import { approveCatalogueRequestOffer } from "@/lib/db"
import catalogueSql from "@/lib/db-catalogue-public"

// TODO: swap for the real domain once the catalogue site is deployed.
const ALLOWED_ORIGIN = "https://yubisayu-catalogue.netlify.app"
const MAX_BODY_BYTES = 512

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

type Params = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  const { id: idStr } = await params
  const id = Number(idStr)
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400, headers: corsHeaders() })
  }

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
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders() })
  }

  const customerHandle = String((body as Record<string, unknown>).customerHandle ?? "").trim()
  if (!customerHandle) {
    return NextResponse.json({ error: "customerHandle is required" }, { status: 400, headers: corsHeaders() })
  }

  try {
    await approveCatalogueRequestOffer(id, customerHandle, catalogueSql)
    return NextResponse.json({ success: true }, { headers: corsHeaders() })
  } catch (err) {
    if (err instanceof Error && err.message === "Request not found or already handled") {
      return NextResponse.json({ error: err.message }, { status: 409, headers: corsHeaders() })
    }
    console.error("Failed to approve request offer:", err)
    return NextResponse.json({ error: "Failed to approve offer" }, { status: 500, headers: corsHeaders() })
  }
}
```

`app/api/public/catalogue/requests/[id]/reject/route.ts` — identical
except `import { rejectCatalogueRequestOffer }`, calling it instead of
`approveCatalogueRequestOffer`, and the final catch's log line reading
`"Failed to reject request offer:"` / error `"Failed to reject offer"`.

- [ ] **Step 3: Review the existing public GET response**

Open `app/api/public/catalogue/requests/route.ts`'s `GET` handler — it
already calls `getCatalogueRequestsByHandle`, which Task 2 updated to
select and return the four new fields via `toRequest`. No code change
needed here; this step is confirming that by reading the file, not
assuming it from the task description alone.

- [ ] **Step 4: Manual verification**

Using a request already moved to `offer_pending` by Task 3's verification:

```bash
curl -s -X POST "http://localhost:3001/api/public/catalogue/requests/<id>/approve" \
  -H "Content-Type: application/json" \
  -d '{"customerHandle":"<the real handle on that request>"}'
```

Expected: `{"success":true}`. Confirm via the public status lookup:

```bash
curl -s "http://localhost:3001/api/public/catalogue/requests?handle=<handle>" | python3 -m json.tool
```

Expected: that request's `status` is now `"approved"`, and
`countryName`/`valas`/`gram`/`estimatedPrice` are all populated (never
`kurs`/`cargoPerKg`/`cogs` — confirm those never appear anywhere in the
response body). Then test the guard: repeat the same approve call.

Expected: `409 {"error":"Request not found or already handled"}` (already
`approved`, not `offer_pending`). Test wrong handle on a fresh
`offer_pending` request (create one via Task 3's edit verification again if
needed):

```bash
curl -s -X POST "http://localhost:3001/api/public/catalogue/requests/<id>/reject" \
  -H "Content-Type: application/json" \
  -d '{"customerHandle":"someone_else_entirely"}'
```

Expected: `409` (handle doesn't match, guarded `UPDATE` touches zero rows).

- [ ] **Step 5: Commit**

```bash
git add app/api/public/catalogue/requests/[id]/approve/route.ts \
        app/api/public/catalogue/requests/[id]/reject/route.ts \
        lib/db/catalogue-requests.ts
git commit -m "feat(catalogue): public approve/reject endpoints for a revised offer"
```

---

### Task 6: Owner UI — Edit/Cancel, offer/approved display, Create Product shortcut

**Files:**
- Modify: `app/dashboard/order-requests/OrderRequestsClient.tsx`

**Interfaces:**
- Consumes: `PUT /api/sheets/order-requests/[id]` with `action: "edit" |
  "cancel-edit"` (Task 3), `GET /api/sheets/order-requests/preview-price`
  (Task 4), `GET /api/sheets/products` for the countries dropdown meta
  (already exists, returns `{countries: CountryRow[], stores: string[]}`
  per `app/api/sheets/products/route.ts`), `POST /api/sheets/products`
  (already exists) for Create Product.
- Produces: no later task depends on this one.

- [ ] **Step 1: Fetch countries alongside the existing options load**

At the top of `OrderRequestsClient` (after the existing `const [error,
setError] = useState<string | null>(null)` line, around line 14), add:

```typescript
  const [countries, setCountries] = useState<{ id: number; name: string }[]>([])

  useEffect(() => {
    fetch("/api/sheets/products", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => setCountries(data.countries ?? []))
      .catch(() => {})
  }, [])
```

(This reuses the existing products-page meta endpoint rather than adding a
new one — it already returns the full country list this component needs,
and fetching it once here costs nothing extra the products page doesn't
already pay.)

- [ ] **Step 2: Add per-status action state and branch the action buttons**

Replace the two `useState` lines for `convertingId`/`rejectingId` (lines
15-16) — keep them, and add two more:

```typescript
  const [convertingId, setConvertingId] = useState<number | null>(null)
  const [rejectingId, setRejectingId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [creatingProductForId, setCreatingProductForId] = useState<number | null>(null)
```

Replace the action-buttons block inside the `requests.map((r) => ...)`
(currently lines 70-73, the `<div className="flex gap-2 shrink-0">...`)
with a status-branched version:

```tsx
            <div className="flex gap-2 shrink-0 items-center">
              {r.status === "pending" && (
                <>
                  <button onClick={() => setConvertingId(r.id)} className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs">Convert</button>
                  <button onClick={() => setRejectingId(r.id)} className="px-3 py-1.5 rounded-lg border border-cream-border text-xs">Reject</button>
                  {r.productId === null && (
                    <button onClick={() => setEditingId(r.id)} className="px-3 py-1.5 rounded-lg border border-cream-border text-xs">Edit</button>
                  )}
                </>
              )}
              {r.status === "offer_pending" && (
                <>
                  <span className="text-xs text-amber-600 font-medium">Menunggu persetujuan customer</span>
                  <button onClick={() => cancelEdit(r.id)} className="px-3 py-1.5 rounded-lg border border-cream-border text-xs">Cancel</button>
                </>
              )}
              {r.status === "approved" && (
                <>
                  <span className="text-xs text-green-600 font-medium">Customer approved ✓ Rp {fmt(r.estimatedPrice ?? 0)}</span>
                  <button onClick={() => setCreatingProductForId(r.id)} className="px-3 py-1.5 rounded-lg border border-cream-border text-xs">Create Product</button>
                  <button onClick={() => setConvertingId(r.id)} className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs">Convert</button>
                  <button onClick={() => setRejectingId(r.id)} className="px-3 py-1.5 rounded-lg border border-cream-border text-xs">Reject</button>
                </>
              )}
            </div>
```

`Edit` is gated to `r.productId === null` (custom requests only) —
matching the spec's non-goal that this feature doesn't apply to
product-backed "Fix" requests.

Add the `cancelEdit` helper function inside the component, near `reload`:

```typescript
  async function cancelEdit(id: number) {
    try {
      const res = await fetch(`/api/sheets/order-requests/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel-edit" }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel edit")
    }
  }
```

- [ ] **Step 3: Add the EditModal component**

Add after `RejectModal` (end of file):

```tsx
function EditModal({ requestId, countries, onClose, onDone }: {
  requestId: number
  countries: { id: number; name: string }[]
  onClose: () => void
  onDone: () => void
}) {
  const [countryId, setCountryId] = useState("")
  const [valas, setValas] = useState("")
  const [gram, setGram] = useState("")
  const [preview, setPreview] = useState<number | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  const countryOptions = useMemo(
    () => countries.map((c) => ({ value: String(c.id), label: c.name })),
    [countries],
  )

  useEffect(() => {
    const cId = Number(countryId)
    const v = Number(valas)
    const g = Number(gram)
    if (!cId || !(v > 0) || !(g > 0)) { setPreview(null); return }
    const t = setTimeout(async () => {
      setPreviewLoading(true)
      try {
        const res = await fetch(`/api/sheets/order-requests/preview-price?countryId=${cId}&valas=${v}&gram=${g}`)
        const data = await res.json()
        setPreview(res.ok ? data.estimatedPrice : null)
      } catch {
        setPreview(null)
      } finally {
        setPreviewLoading(false)
      }
    }, 400)
    return () => clearTimeout(t)
  }, [countryId, valas, gram])

  async function submit() {
    if (!countryId) { setError("Pick a country"); return }
    if (!(Number(valas) > 0)) { setError("Enter a valid valas amount"); return }
    if (!(Number(gram) > 0)) { setError("Enter a valid weight"); return }
    setSubmitting(true); setError("")
    try {
      const res = await fetch(`/api/sheets/order-requests/${requestId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "edit", countryId: Number(countryId), valas: Number(valas), gram: Number(gram) }),
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
        <h3 className="text-sm font-semibold text-foreground">Propose a price revision</h3>
        <SearchableSelect value={countryId} onChange={setCountryId} options={countryOptions} placeholder="Country…" />
        <input value={valas} onChange={(e) => setValas(e.target.value)} placeholder="Valas amount" type="number" min="0" step="any" className="border border-cream-border rounded-lg px-2 py-1.5 text-sm" />
        <input value={gram} onChange={(e) => setGram(e.target.value)} placeholder="Weight (gram)" type="number" min="0" step="any" className="border border-cream-border rounded-lg px-2 py-1.5 text-sm" />
        <p className="text-xs text-gray-500">
          {previewLoading ? "Calculating…" : preview != null ? `Estimated price: Rp ${fmt(preview)}` : "—"}
        </p>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Send to customer"}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Add the CreateProductModal component**

A small, dedicated modal — deliberately NOT the full `AddProductForm` from
the Products page (that component has ~15 interacting pricing-method
branches and a live-recomputed price preview built around several
`useRef`/`useEffect` invariants; forcing a "locked price that doesn't
recompute from live kurs" mode into it risks breaking those invariants for
marginal reuse benefit). This posts directly to the existing
`POST /api/sheets/products`, matching exactly the payload shape that
route's `overseas` branch already accepts (see
`app/api/sheets/products/route.ts:46-95` — `price` is trusted verbatim for
this pricing method, confirmed during design):

```tsx
function CreateProductModal({ request, onClose, onDone }: {
  request: CatalogueRequest
  onClose: () => void
  onDone: () => void
}) {
  const [name, setName] = useState(request.description)
  const [price, setPrice] = useState(String(request.estimatedPrice ?? 0))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  async function submit() {
    if (!name.trim()) { setError("Name is required"); return }
    if (!(Number(price) > 0)) { setError("Enter a valid price"); return }
    setSubmitting(true); setError("")
    try {
      const res = await fetch("/api/sheets/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          store: "",
          pricingMethod: "overseas",
          countryId: request.countryId,
          valas: request.valas,
          gram: request.gram,
          profitPct: 15,
          operationalFee: 0,
          packingFee: 0,
          // Locked to exactly what the customer approved — not recomputed
          // from the country's live kurs, which may have moved since. See
          // this plan's Global Constraints and the spec's "Owner
          // Experience" section.
          price: Number(price),
        }),
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
        <h3 className="text-sm font-semibold text-foreground">Create product from approved offer</h3>
        <p className="text-xs text-gray-500">
          {request.countryName} · valas {request.valas} · {request.gram}g
        </p>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Product name" className="border border-cream-border rounded-lg px-2 py-1.5 text-sm" />
        <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Price" type="number" min="0" className="border border-cream-border rounded-lg px-2 py-1.5 text-sm" />
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm">Cancel</button>
          <button onClick={submit} disabled={submitting} className="px-3 py-1.5 rounded-lg bg-brand text-white text-sm disabled:opacity-50">
            {submitting ? "Saving…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Render the two new modals**

After the existing `{rejectingId != null && <RejectModal .../>}` block
(around line 93), add:

```tsx
      {editingId != null && (
        <EditModal
          requestId={editingId}
          countries={countries}
          onClose={() => setEditingId(null)}
          onDone={() => { setEditingId(null); reload() }}
        />
      )}
      {creatingProductForId != null && (() => {
        const req = requests.find((r) => r.id === creatingProductForId)
        return req ? (
          <CreateProductModal
            request={req}
            onClose={() => setCreatingProductForId(null)}
            onDone={() => setCreatingProductForId(null)}
          />
        ) : null
      })()}
```

- [ ] **Step 6: Manual browser verification**

With the dev server running, open `/dashboard/order-requests` as the
owner. For a pending custom request: click Edit, pick a country, enter
valas/gram, confirm the price preview appears after ~400ms and matches
Task 4's route's output for the same inputs, click "Send to customer" —
confirm the row now shows "Menunggu persetujuan customer" and a Cancel
button, Convert/Reject are gone. Click Cancel — confirm it reverts to the
normal pending row. Repeat Edit → Send, then directly call the public
approve endpoint from Task 5 via curl (simulating the customer) — reload
the page, confirm the row now shows "Customer approved ✓ Rp X" plus Create
Product / Convert / Reject. Click Create Product — confirm the name field
is pre-filled from the description and the price field is pre-filled with
the approved estimate; change the name, submit — confirm success, then
verify via the Products page that the new product exists with
`pricingMethod: overseas`, the right country/valas/gram, and a price
exactly matching what was approved (not recomputed from a possibly-moved
live kurs).

- [ ] **Step 7: Commit**

```bash
git add app/dashboard/order-requests/OrderRequestsClient.tsx
git commit -m "feat(catalogue): owner UI for edit/cancel, offer status, and create-product-from-approval"
```

---

## Self-Review

**1. Spec coverage:** Data model (Task 1), owner edit/cancel-edit +
widened convert/reject guards (Tasks 2-3), owner-only live preview
(Task 4), public approve/reject + extended status response (Task 5), owner
UI including the Create Product shortcut with locked price (Task 6) — all
spec sections covered for this repo's half of the feature. Customer-facing
approve/reject UI and the video-catalog proxies are explicitly out of
scope per this plan's Global Constraints (separate plan, other repo).

**2. Placeholder scan:** No "TBD"/"TODO" introduced by this plan (the one
`TODO` in Task 5's route code is copied verbatim from the existing sibling
routes' real, pre-existing domain-swap TODO — not a plan placeholder).

**3. Type consistency:** `editCatalogueRequest`'s return type
(`{estimatedPrice: number}`) matches what Task 3's route returns and what
Task 6's `EditModal` doesn't even need to read (it re-fetches its own
preview). `CatalogueRequest`'s new fields (`countryId`, `countryName`,
`valas`, `gram`, `estimatedPrice`) are consistent across Task 2's type
definition, `toRequest`, both read functions' SQL, and Task 6's UI usage
(`request.countryName`, `request.valas`, `request.gram`,
`request.estimatedPrice`). `getCountryRate`'s `{kurs, cargoPerKg}` shape is
used identically by Task 2's `editCatalogueRequest` and Task 4's preview
route.

**4. Scope check:** One cohesive backend addition — schema, data layer,
three route surfaces, owner UI. The customer-facing half is a separate
plan by design (this repo's contracts must be real and verified before the
other repo's frontend can be built against them, matching this whole
feature family's established two-plan convention).
