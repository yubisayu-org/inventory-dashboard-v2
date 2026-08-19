# Claim Capture Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store posts, claims and slots; turn an uploaded reply image into a recorded claim using the resolver library; and turn a named slot into real products, orders and a recorded purchase through the paths that already exist.

**Architecture:** A thin data layer in `lib/db/claims.ts` beside the existing `lib/db/*` modules, an ingestion function that calls `lib/claims` (plan 1), and a naming function that composes the existing `computeProductPrice`, `addProduct` and `appendOrders`. Post images live in Supabase Storage; everything else is Postgres. No UI — that is plan 2b.

**Tech Stack:** TypeScript, `postgres` (already used), `@supabase/supabase-js` (new — see Task 2), `node:test` via `tsx`.

**Spec:** [docs/superpowers/specs/2026-08-16-whatsapp-claim-capture-design.md](../specs/2026-08-16-whatsapp-claim-capture-design.md)

**Depends on:** [2026-08-16-claim-resolvers.md](2026-08-16-claim-resolvers.md) — complete, `lib/claims/`.

## Decisions already made

Settled with the owner on 2026-08-16; do not relitigate mid-build.

- **Naming may happen before OR after buying.** These are two independent
  actions; the only ordering constraint is that orders must exist before a
  purchase can be recorded against them. A slot therefore carries its own bought
  count, and naming applies any pending count at the moment orders are created.
- **A post carries store, country, event and pricing method.** Naming a slot
  supplies only name, valas and gram.
- **Gram is known at naming time**, so prices are correct immediately and
  nothing needs repricing later.
- **Pricing method** has its own global default for WhatsApp posts, separate
  from `product_defaults.default_pricing_method` (which drives the Add Product
  form's opening tab). Per-post override, because it varies by store.
- **Under 100 posts per event.** Listing needs pagination and search.
- **Separate storage bucket** for group posts, not the catalogue branch's.
- **Reply images are discarded once their claim is confirmed**; post images are
  kept. The group chat is the audit trail.

## Global Constraints

- Node `22.x` per `package.json` `engines`.
- Migrations start at **062**. 058-060 belong to `catalogue-order-requests`, 061
  is Target Price. `supabase migration up` does **not** work on this branch —
  the local DB carries 058-060 which do not exist here — so migrations are
  applied by piping to psql, exactly as 061 was.
- Money is INTEGER rupiah, as everywhere else in this schema.
- Positions are normalized 0..1 doubles, matching `lib/claims`.
- Customer handles are bare lowercase; use `normalizeCustomer` / `normalizeId`
  rather than hand-rolling.
- Comments explain *why*, at the density of `lib/db/fulfillment.ts`.

---

### Task 1: Migration 062 — posts, claims, slots

**Files:**
- Create: `supabase/migrations/062_whatsapp_claims.sql`

**Interfaces:**
- Produces tables `wa_posts`, `wa_claims`, `wa_slots`, and the column
  `product_defaults.whatsapp_pricing_method`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/062_whatsapp_claims.sql`:

```sql
-- Claim capture from WhatsApp groups.
--
-- Three tables, in the order a claim travels: a POST is an image the owner sent
-- to a group; a CLAIM is one customer's reply resolved to a position or a
-- variant; a SLOT is the group of claims that mean the same item.
--
-- Slots are derived, not authored: clustering recomputes them from claims. They
-- carry the two things that are NOT derivable — how many were bought, and which
-- product they turned out to be once named.

CREATE TABLE wa_posts (
  id            SERIAL PRIMARY KEY,
  event         TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE,
  -- Object path in the posts bucket. The image itself never lives in Postgres.
  image_path    TEXT NOT NULL,
  image_width   INTEGER NOT NULL DEFAULT 0,
  image_height  INTEGER NOT NULL DEFAULT 0,
  -- Everything a named slot inherits, so naming asks only for name/valas/gram.
  store         TEXT NOT NULL DEFAULT '',
  country_id    INTEGER REFERENCES countries(id) ON DELETE RESTRICT,
  pricing_method TEXT NOT NULL DEFAULT 'overseas',
  -- Free text listing variants ("warna: hitam/merah\nsize: 38-42"). Empty for a
  -- shelf photo, which has no declared variants — its slots are discovered.
  note          TEXT NOT NULL DEFAULT '',
  -- Hues (degrees) that are safe to read as pen ink on THIS photo, computed
  -- from its own histogram at post time. Stored rather than recomputed so every
  -- reply is resolved against the same answer.
  safe_hues     INTEGER[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ
);

CREATE INDEX idx_wa_posts_event ON wa_posts (event);

ALTER TABLE wa_posts DROP CONSTRAINT IF EXISTS wa_posts_pricing_method_check;
ALTER TABLE wa_posts ADD CONSTRAINT wa_posts_pricing_method_check
  CHECK (pricing_method IN ('overseas', 'tier_fee', 'flat_fee', 'tier_kurs', 'flat_kurs', 'target_price'));

CREATE TABLE wa_claims (
  id            SERIAL PRIMARY KEY,
  post_id       INTEGER NOT NULL REFERENCES wa_posts(id) ON DELETE CASCADE,
  -- The sender's WhatsApp number, digits only. Kept even after the customer is
  -- resolved, because that resolution can be corrected later.
  sender        TEXT NOT NULL DEFAULT '',
  -- Bare lowercase IG handle once known. Null means unresolved, which is a
  -- review state rather than an error.
  customer      TEXT REFERENCES customers(instagram_id) ON UPDATE CASCADE,
  source        TEXT NOT NULL,
  -- Normalized 0..1. Null for a variant claim, which has no position.
  point_x       DOUBLE PRECISION,
  point_y       DOUBLE PRECISION,
  -- Variant id from parseVariantNote, e.g. "hitam|38". Null for a shelf claim.
  variant_id    TEXT,
  quantity      INTEGER NOT NULL DEFAULT 1,
  -- A size or colour the customer asked for that the photo cannot express.
  -- Raw and unparsed: a shelf has no variant list to resolve it against.
  note          TEXT NOT NULL DEFAULT '',
  -- Resolver confidence, 0..1. Low values are what route a claim to review.
  confidence    DOUBLE PRECISION NOT NULL DEFAULT 1,
  state         TEXT NOT NULL DEFAULT 'pending',
  -- WhatsApp message id, so the reaction on it can be updated later.
  message_id    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ
);

CREATE INDEX idx_wa_claims_post ON wa_claims (post_id);
CREATE INDEX idx_wa_claims_state ON wa_claims (state);

ALTER TABLE wa_claims DROP CONSTRAINT IF EXISTS wa_claims_source_check;
ALTER TABLE wa_claims ADD CONSTRAINT wa_claims_source_check
  CHECK (source IN ('ink', 'crop', 'repost', 'text', 'manual'));

-- pending  — captured, not yet part of a slot
-- assigned — belongs to a slot
-- review   — needs a human: unresolved position, unknown sender, unclear text
-- rejected — the owner discarded it
ALTER TABLE wa_claims DROP CONSTRAINT IF EXISTS wa_claims_state_check;
ALTER TABLE wa_claims ADD CONSTRAINT wa_claims_state_check
  CHECK (state IN ('pending', 'assigned', 'review', 'rejected'));

CREATE TABLE wa_slots (
  id            SERIAL PRIMARY KEY,
  post_id       INTEGER NOT NULL REFERENCES wa_posts(id) ON DELETE CASCADE,
  -- Cluster centre for a shelf slot; null for a variant slot.
  point_x       DOUBLE PRECISION,
  point_y       DOUBLE PRECISION,
  variant_id    TEXT,
  -- How many were actually obtained. Independent of orders on purpose: the
  -- owner tallies in the shop, and naming may not have happened yet.
  bought        INTEGER NOT NULL DEFAULT 0,
  -- Set once the slot is named. Null means "nobody has said what this is".
  product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ
);

CREATE INDEX idx_wa_slots_post ON wa_slots (post_id);

ALTER TABLE wa_claims ADD COLUMN IF NOT EXISTS slot_id INTEGER
  REFERENCES wa_slots(id) ON DELETE SET NULL;
CREATE INDEX idx_wa_claims_slot ON wa_claims (slot_id);

-- Which pricing method a NEW WhatsApp post starts on.
--
-- Deliberately separate from default_pricing_method (migration 055), which
-- decides the Add Product form's opening tab: the owner wants these to differ,
-- and sharing one column would make changing either change both.
ALTER TABLE product_defaults
  ADD COLUMN IF NOT EXISTS whatsapp_pricing_method TEXT NOT NULL DEFAULT 'overseas';

ALTER TABLE product_defaults DROP CONSTRAINT IF EXISTS product_defaults_whatsapp_pricing_method_check;
ALTER TABLE product_defaults ADD CONSTRAINT product_defaults_whatsapp_pricing_method_check
  CHECK (whatsapp_pricing_method IN ('overseas', 'tier_fee', 'flat_fee', 'tier_kurs', 'flat_kurs', 'target_price'));
```

- [ ] **Step 2: Apply it to the local dev database**

`supabase migration up` cannot run on this branch — see Global Constraints.

```bash
PSQL=psql; [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
"$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/062_whatsapp_claims.sql
```

Expected: no errors.

- [ ] **Step 3: Verify the tables landed**

```bash
PSQL=psql; [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
"$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d wa_posts" -c "\d wa_claims" -c "\d wa_slots" | head -60
"$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "SELECT whatsapp_pricing_method FROM product_defaults WHERE id = 1;"
```

Expected: three tables described, and `overseas` for the new default.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/062_whatsapp_claims.sql
git commit -m "feat(db): tables for WhatsApp claim capture

Three tables in the order a claim travels: a post is an image sent to a group,
a claim is one customer's reply resolved to a position or a variant, and a slot
groups the claims that mean the same item.

Slots are derived from clustering, so they store only what clustering cannot
recompute: how many were bought, and which product the slot turned out to be
once named. Both are nullable because the owner tallies in the shop long before
anything is named, and may never name a slot nobody claimed.

Safe pen hues are snapshotted per post rather than recomputed per reply, so
every reply to one photo is judged against the same answer.

The WhatsApp default pricing method is its own column rather than sharing
default_pricing_method (055): that one decides the Add Product form's opening
tab, and the owner wants the two to differ."
```

---

### Task 2: Supabase Storage client and the posts bucket

**Files:**
- Modify: `package.json` (add `@supabase/supabase-js`)
- Create: `lib/storage.ts`
- Modify: `.env.development.local` (local keys — not committed)
- Create: `supabase/migrations/063_wa_posts_bucket.sql`

**Interfaces:**
- Produces:
  - `WA_POSTS_BUCKET = "wa-posts"`
  - `uploadPostImage(path: string, body: Buffer, contentType: string): Promise<void>`
  - `downloadPostImage(path: string): Promise<Buffer>`
  - `postImageUrl(path: string, expiresInSeconds?: number): Promise<string>`

> **Confirm before starting:** this task needs `SUPABASE_URL` and
> `SUPABASE_SERVICE_ROLE_KEY` for production, and the local stack's equivalents
> for dev (`supabase status` prints them). If the owner would rather not add a
> storage dependency, the alternative is a `bytea` column on `wa_posts` — no new
> dependency or env, at the cost of roughly 700 MB a year inside Postgres and
> every render pulling the image through the database connection. Storage is the
> recommendation; stop and ask if the keys are not available.

- [ ] **Step 1: Add the dependency**

```bash
npm install @supabase/supabase-js
```

- [ ] **Step 2: Create the bucket**

Create `supabase/migrations/063_wa_posts_bucket.sql`:

```sql
-- A private bucket for group post images.
--
-- Separate from the catalogue branch's bucket on purpose: these two features
-- ship independently, and sharing a bucket would couple their retention and
-- access rules together for no benefit.
--
-- Private, not public: a post image shows a shop shelf and, once annotated,
-- who wants what. It is served through signed URLs from the dashboard rather
-- than being world-readable.
INSERT INTO storage.buckets (id, name, public)
VALUES ('wa-posts', 'wa-posts', false)
ON CONFLICT (id) DO NOTHING;
```

Apply it the same way as Task 1.

- [ ] **Step 3: Write the failing test**

Create `lib/storage.test.ts`:

```typescript
import { test } from "node:test"
import assert from "node:assert/strict"
import { WA_POSTS_BUCKET, uploadPostImage, downloadPostImage } from "./storage"

test("an uploaded image comes back byte-identical", async () => {
  const body = Buffer.from("not really a jpeg, but bytes are bytes")
  const path = `test/${Date.now()}.txt`

  await uploadPostImage(path, body, "text/plain")
  const roundTripped = await downloadPostImage(path)

  assert.equal(roundTripped.toString(), body.toString())
})

test("the bucket name is the one the migration created", () => {
  assert.equal(WA_POSTS_BUCKET, "wa-posts")
})
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `npx tsx --test lib/storage.test.ts`
Expected: FAIL — cannot resolve `./storage`.

- [ ] **Step 5: Implement**

Create `lib/storage.ts`:

```typescript
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

/** Group post images. Private; see migration 063 for why. */
export const WA_POSTS_BUCKET = "wa-posts"

let client: SupabaseClient | null = null

/**
 * Storage client, created on first use.
 *
 * Lazy rather than module-level so that importing anything from this file does
 * not require the env to be present — the dashboard imports type-only paths in
 * places that never touch storage.
 *
 * The service role key is used because these objects are private and every
 * caller is already an authenticated owner or admin; the anon key would need
 * storage policies to express a rule the app has already enforced.
 */
function storage(): SupabaseClient {
  if (client !== null) return client
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for post images")
  }
  client = createClient(url, key, { auth: { persistSession: false } })
  return client
}

export async function uploadPostImage(
  path: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const { error } = await storage()
    .storage.from(WA_POSTS_BUCKET)
    .upload(path, body, { contentType, upsert: true })
  if (error) throw error
}

export async function downloadPostImage(path: string): Promise<Buffer> {
  const { data, error } = await storage().storage.from(WA_POSTS_BUCKET).download(path)
  if (error) throw error
  return Buffer.from(await data.arrayBuffer())
}

/**
 * A time-limited URL for the dashboard to render.
 *
 * Signed rather than public: the bucket holds shelf photos that, once
 * annotated, show who wants what.
 */
export async function postImageUrl(path: string, expiresInSeconds = 3600): Promise<string> {
  const { data, error } = await storage()
    .storage.from(WA_POSTS_BUCKET)
    .createSignedUrl(path, expiresInSeconds)
  if (error) throw error
  return data.signedUrl
}
```

- [ ] **Step 6: Add local env vars**

Run `supabase status` and copy `API URL` and `service_role key` into
`.env.development.local`:

```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<service_role key from supabase status>
```

- [ ] **Step 7: Run the test to confirm it passes**

Run: `npx tsx --env-file=.env.development.local --test lib/storage.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 8: Widen the test script and commit**

In `package.json`, change the `test` script so it covers both directories and
loads the dev env:

```json
"test": "tsx --env-file-if-exists=.env.development.local --test lib/claims/*.test.ts lib/*.test.ts lib/db/*.test.ts"
```

Run: `npm test`
Expected: PASS — the 48 resolver tests plus the 2 storage tests.

```bash
git add package.json package-lock.json lib/storage.ts lib/storage.test.ts supabase/migrations/063_wa_posts_bucket.sql
git commit -m "feat(storage): private bucket and client for post images

A separate bucket from the catalogue branch's: the two features ship
independently, and sharing one would couple their retention and access rules
for no benefit.

Private with signed URLs rather than public, because an annotated post shows a
shop shelf and who wants what. The client is created lazily so importing this
module does not require the env to be present."
```

---

### Task 3: Data layer for posts, claims and slots

**Files:**
- Create: `lib/db/claims.ts`
- Create: `lib/db/claims.test.ts`
- Modify: `lib/db/index.ts` (re-export, following the existing pattern)

**Interfaces:**
- Consumes: `sql` from `lib/db-pool`, `DBExecutor` from `lib/db/actor`.
- Produces:
  - `createPost(input): Promise<{ id: number }>` where input is
    `{ event, imagePath, imageWidth, imageHeight, store, countryId, pricingMethod, note, safeHues }`
  - `getPost(id): Promise<WaPost | null>`
  - `listPosts(opts: { event?: string; search?: string; page: number; pageSize: number }): Promise<{ rows: WaPost[]; totalCount: number }>`
  - `addClaim(input): Promise<{ id: number }>` where input is
    `{ postId, sender, customer, source, point, variantId, quantity, note, confidence, state, messageId }`
  - `listClaims(postId): Promise<WaClaim[]>`
  - `setSlots(postId, slots): Promise<void>` — replaces the post's slots and re-points its claims
  - `listSlots(postId): Promise<WaSlot[]>`
  - `setSlotBought(slotId, bought): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `lib/db/claims.test.ts`:

```typescript
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { createPost, getPost, addClaim, listClaims, setSlots, listSlots, setSlotBought } from "./claims"

const EVENT = `TEST${Date.now()}`

before(async () => {
  await sql`INSERT INTO events (name) VALUES (${EVENT}) ON CONFLICT DO NOTHING`
})

after(async () => {
  // wa_posts cascades to claims and slots.
  await sql`DELETE FROM wa_posts WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

test("a post round-trips with everything a slot inherits", async () => {
  const { id } = await createPost({
    event: EVENT,
    imagePath: "test/shelf.jpg",
    imageWidth: 1600,
    imageHeight: 2133,
    store: "Nishimatsuya",
    countryId: null,
    pricingMethod: "tier_kurs",
    note: "",
    safeHues: [130, 280],
  })

  const post = await getPost(id)
  assert.ok(post)
  assert.equal(post.store, "Nishimatsuya")
  assert.equal(post.pricingMethod, "tier_kurs")
  assert.deepEqual(post.safeHues, [130, 280])
})

test("claims record a position and survive re-reading", async () => {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: "test/a.jpg", imageWidth: 100, imageHeight: 100,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })

  await addClaim({
    postId, sender: "628111019159", customer: null, source: "ink",
    point: { x: 0.24, y: 0.78 }, variantId: null, quantity: 1,
    note: "size 90", confidence: 1, state: "pending", messageId: "msg-1",
  })

  const claims = await listClaims(postId)
  assert.equal(claims.length, 1)
  assert.equal(claims[0].sender, "628111019159")
  assert.equal(claims[0].note, "size 90")
  assert.ok(Math.abs((claims[0].point?.x ?? 0) - 0.24) < 1e-9)
})

test("setSlots replaces slots and points claims at them", async () => {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: "test/b.jpg", imageWidth: 100, imageHeight: 100,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  const a = await addClaim({
    postId, sender: "1", customer: null, source: "ink", point: { x: 0.2, y: 0.8 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  const b = await addClaim({
    postId, sender: "2", customer: null, source: "ink", point: { x: 0.21, y: 0.79 },
    variantId: null, quantity: 2, note: "", confidence: 1, state: "pending", messageId: "",
  })

  await setSlots(postId, [
    { point: { x: 0.205, y: 0.795 }, variantId: null, claimIds: [a.id, b.id] },
  ])

  const slots = await listSlots(postId)
  assert.equal(slots.length, 1)
  assert.equal(slots[0].claimed, 3, "quantities of both claims sum into the slot")

  const claims = await listClaims(postId)
  assert.ok(claims.every((c) => c.slotId === slots[0].id))
  assert.ok(claims.every((c) => c.state === "assigned"))
})

test("re-clustering preserves what a slot already knows", async () => {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: "test/c.jpg", imageWidth: 100, imageHeight: 100,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  const first = await addClaim({
    postId, sender: "1", customer: null, source: "ink", point: { x: 0.5, y: 0.5 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  await setSlots(postId, [{ point: { x: 0.5, y: 0.5 }, variantId: null, claimIds: [first.id] }])

  const [slot] = await listSlots(postId)
  await setSlotBought(slot.id, 2)

  // A later claim arrives and clustering runs again over the same position.
  const second = await addClaim({
    postId, sender: "2", customer: null, source: "ink", point: { x: 0.51, y: 0.5 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  await setSlots(postId, [
    { point: { x: 0.505, y: 0.5 }, variantId: null, claimIds: [first.id, second.id] },
  ])

  const after = await listSlots(postId)
  assert.equal(after.length, 1)
  assert.equal(after[0].bought, 2, "a tally made in the shop must survive re-clustering")
  assert.equal(after[0].claimed, 2)
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/claims.test.ts`
Expected: FAIL — cannot resolve `./claims`.

- [ ] **Step 3: Implement**

Create `lib/db/claims.ts`:

```typescript
import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { tsToString } from "./helpers"
import { toPricingMethod, type PricingMethod } from "@/lib/pricing"
import type { Point } from "@/lib/claims"

export interface WaPost {
  id: number
  event: string
  imagePath: string
  imageWidth: number
  imageHeight: number
  store: string
  countryId: number | null
  pricingMethod: PricingMethod
  note: string
  safeHues: number[]
  createdAt: string
}

export type ClaimSource = "ink" | "crop" | "repost" | "text" | "manual"
export type ClaimState = "pending" | "assigned" | "review" | "rejected"

export interface WaClaim {
  id: number
  postId: number
  sender: string
  customer: string | null
  source: ClaimSource
  point: Point | null
  variantId: string | null
  quantity: number
  note: string
  confidence: number
  state: ClaimState
  messageId: string
  slotId: number | null
  createdAt: string
}

export interface WaSlot {
  id: number
  postId: number
  point: Point | null
  variantId: string | null
  /** Sum of the quantities of the claims attached to this slot. Derived. */
  claimed: number
  bought: number
  productId: number | null
}

export async function createPost(input: {
  event: string
  imagePath: string
  imageWidth: number
  imageHeight: number
  store: string
  countryId: number | null
  pricingMethod: PricingMethod
  note: string
  safeHues: number[]
}, db: DBExecutor = sql): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO wa_posts (event, image_path, image_width, image_height, store,
      country_id, pricing_method, note, safe_hues)
    VALUES (${input.event}, ${input.imagePath}, ${input.imageWidth},
      ${input.imageHeight}, ${input.store}, ${input.countryId},
      ${input.pricingMethod}, ${input.note}, ${input.safeHues})
    RETURNING id
  `
  return { id: row.id }
}

function mapPost(r: Record<string, unknown>): WaPost {
  return {
    id: r.id as number,
    event: r.event as string,
    imagePath: r.image_path as string,
    imageWidth: (r.image_width as number) ?? 0,
    imageHeight: (r.image_height as number) ?? 0,
    store: (r.store as string) ?? "",
    countryId: (r.country_id as number | null) ?? null,
    pricingMethod: toPricingMethod(r.pricing_method),
    note: (r.note as string) ?? "",
    safeHues: ((r.safe_hues as number[]) ?? []).map(Number),
    createdAt: tsToString(r.created_at as Date | null),
  }
}

export async function getPost(id: number): Promise<WaPost | null> {
  const [row] = await sql`SELECT * FROM wa_posts WHERE id = ${id}`
  return row ? mapPost(row) : null
}

/**
 * One page of posts. Under 100 per event, but they accumulate across events,
 * so this paginates like every other list in the dashboard.
 */
export async function listPosts(opts: {
  event?: string
  search?: string
  page: number
  pageSize: number
}): Promise<{ rows: WaPost[]; totalCount: number }> {
  const offset = (opts.page - 1) * opts.pageSize
  const event = opts.event ?? null
  const search = opts.search ? `%${opts.search.toLowerCase()}%` : null

  const rows = await sql`
    SELECT * FROM wa_posts
    WHERE (${event}::text IS NULL OR event = ${event})
      AND (${search}::text IS NULL OR lower(store) LIKE ${search} OR lower(note) LIKE ${search})
    ORDER BY id DESC
    LIMIT ${opts.pageSize} OFFSET ${offset}
  `
  const [{ total }] = await sql`
    SELECT COUNT(*)::int AS total FROM wa_posts
    WHERE (${event}::text IS NULL OR event = ${event})
      AND (${search}::text IS NULL OR lower(store) LIKE ${search} OR lower(note) LIKE ${search})
  `
  return { rows: rows.map(mapPost), totalCount: total }
}

export async function addClaim(input: {
  postId: number
  sender: string
  customer: string | null
  source: ClaimSource
  point: Point | null
  variantId: string | null
  quantity: number
  note: string
  confidence: number
  state: ClaimState
  messageId: string
}, db: DBExecutor = sql): Promise<{ id: number }> {
  const [row] = await db`
    INSERT INTO wa_claims (post_id, sender, customer, source, point_x, point_y,
      variant_id, quantity, note, confidence, state, message_id)
    VALUES (${input.postId}, ${input.sender}, ${input.customer}, ${input.source},
      ${input.point?.x ?? null}, ${input.point?.y ?? null}, ${input.variantId},
      ${input.quantity}, ${input.note}, ${input.confidence}, ${input.state},
      ${input.messageId})
    RETURNING id
  `
  return { id: row.id }
}

function mapClaim(r: Record<string, unknown>): WaClaim {
  const x = r.point_x as number | null
  const y = r.point_y as number | null
  return {
    id: r.id as number,
    postId: r.post_id as number,
    sender: (r.sender as string) ?? "",
    customer: (r.customer as string | null) ?? null,
    source: r.source as ClaimSource,
    point: x === null || y === null ? null : { x: Number(x), y: Number(y) },
    variantId: (r.variant_id as string | null) ?? null,
    quantity: (r.quantity as number) ?? 1,
    note: (r.note as string) ?? "",
    confidence: Number(r.confidence ?? 1),
    state: r.state as ClaimState,
    messageId: (r.message_id as string) ?? "",
    slotId: (r.slot_id as number | null) ?? null,
    createdAt: tsToString(r.created_at as Date | null),
  }
}

export async function listClaims(postId: number): Promise<WaClaim[]> {
  const rows = await sql`SELECT * FROM wa_claims WHERE post_id = ${postId} ORDER BY id ASC`
  return rows.map(mapClaim)
}

/**
 * Replace a post's slots with a freshly clustered set.
 *
 * Clustering is recomputed whenever a claim arrives, so this runs often. What
 * it must NOT do is discard the two things a slot knows that clustering cannot
 * recompute — the shop tally and the product it was named as. Those are matched
 * back by position, because the owner is looking at a photo and a slot that
 * moved half a percent is the same slot to them.
 */
export async function setSlots(
  postId: number,
  slots: { point: Point | null; variantId: string | null; claimIds: number[] }[],
): Promise<void> {
  await sql.begin(async (tx) => {
    const existing = await tx`SELECT * FROM wa_slots WHERE post_id = ${postId}`

    // Carry forward bought/product by nearest previous slot centre. A variant
    // slot matches by id instead, since it has no position.
    const carried = slots.map((slot) => {
      const previous = existing.find((e) => {
        if (slot.variantId !== null) return e.variant_id === slot.variantId
        if (slot.point === null || e.point_x === null) return false
        return Math.hypot(Number(e.point_x) - slot.point.x, Number(e.point_y) - slot.point.y) < 0.03
      })
      return {
        ...slot,
        bought: (previous?.bought as number) ?? 0,
        productId: (previous?.product_id as number | null) ?? null,
      }
    })

    await tx`UPDATE wa_claims SET slot_id = NULL WHERE post_id = ${postId}`
    await tx`DELETE FROM wa_slots WHERE post_id = ${postId}`

    for (const slot of carried) {
      const [row] = await tx`
        INSERT INTO wa_slots (post_id, point_x, point_y, variant_id, bought, product_id)
        VALUES (${postId}, ${slot.point?.x ?? null}, ${slot.point?.y ?? null},
          ${slot.variantId}, ${slot.bought}, ${slot.productId})
        RETURNING id
      `
      if (slot.claimIds.length > 0) {
        await tx`
          UPDATE wa_claims SET slot_id = ${row.id}, state = 'assigned', updated_at = NOW()
          WHERE id IN ${tx(slot.claimIds)}
        `
      }
    }
  })
}

export async function listSlots(postId: number): Promise<WaSlot[]> {
  const rows = await sql`
    SELECT s.*, COALESCE(SUM(c.quantity), 0)::int AS claimed
    FROM wa_slots s
    LEFT JOIN wa_claims c ON c.slot_id = s.id AND c.state <> 'rejected'
    WHERE s.post_id = ${postId}
    GROUP BY s.id
    ORDER BY s.id ASC
  `
  return rows.map((r) => {
    const x = r.point_x as number | null
    const y = r.point_y as number | null
    return {
      id: r.id as number,
      postId: r.post_id as number,
      point: x === null || y === null ? null : { x: Number(x), y: Number(y) },
      variantId: (r.variant_id as string | null) ?? null,
      claimed: (r.claimed as number) ?? 0,
      bought: (r.bought as number) ?? 0,
      productId: (r.product_id as number | null) ?? null,
    }
  })
}

/** The shop tally. Independent of orders, which may not exist yet. */
export async function setSlotBought(
  slotId: number,
  bought: number,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE wa_slots SET bought = ${bought}, updated_at = NOW() WHERE id = ${slotId}
  `
}
```

- [ ] **Step 4: Re-export from the db barrel**

Add to `lib/db/index.ts`, matching the existing export style:

```typescript
export * from "./claims"
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS — 48 resolver + 2 storage + 4 claims tests.

- [ ] **Step 6: Commit**

```bash
git add lib/db/claims.ts lib/db/claims.test.ts lib/db/index.ts
git commit -m "feat(db): data layer for posts, claims and slots

Clustering recomputes slots whenever a claim arrives, so setSlots runs often and
must not discard what a slot knows that clustering cannot recompute: the tally
the owner made standing in the shop, and the product it was named as. Those are
carried forward by nearest previous centre, because a slot that moved half a
percent is the same slot to someone looking at a photograph.

claimed is derived by summing attached claims rather than stored, so it cannot
drift from the claims it counts."
```

---

### Task 4: Ingest a reply image into a claim

**Files:**
- Create: `lib/whatsapp/ingest.ts`
- Create: `lib/whatsapp/ingest.test.ts`

**Interfaces:**
- Consumes: `resolveImageReply`, `clusterPoints`, `resolveText`, `parseVariantNote` from `lib/claims`; the data layer from Task 3; `downloadPostImage` from Task 2.
- Produces:
  - `ingestImageReply(input: { postId: number; sender: string; messageId: string; replyPath: string; caption: string }): Promise<{ claimIds: number[] }>`
  - `recluster(postId: number): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `lib/whatsapp/ingest.test.ts`:

```typescript
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { FIXTURES } from "../claims/fixtures"
import { createPost, listClaims, listSlots } from "../db/claims"
import { ingestImageReply } from "./ingest"

const EVENT = `TESTING${Date.now()}`

before(async () => {
  await sql`INSERT INTO events (name) VALUES (${EVENT}) ON CONFLICT DO NOTHING`
})

after(async () => {
  await sql`DELETE FROM wa_posts WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

async function shelfPost() {
  return createPost({
    event: EVENT,
    imagePath: FIXTURES.original, // a local path is enough for the resolver
    imageWidth: 1600,
    imageHeight: 2133,
    store: "Nishimatsuya",
    countryId: null,
    pricingMethod: "overseas",
    note: "",
    safeHues: [130],
  })
}

test("a ticked reply becomes one claim per mark", async () => {
  const { id: postId } = await shelfPost()
  const { claimIds } = await ingestImageReply({
    postId, sender: "628111019159", messageId: "m1",
    replyPath: FIXTURES.ticked, caption: "",
  })
  assert.equal(claimIds.length, 2)

  const claims = await listClaims(postId)
  assert.ok(claims.every((c) => c.source === "ink"))
  assert.ok(claims.every((c) => c.point !== null))
})

test("a caption rides along as the claim's note", async () => {
  const { id: postId } = await shelfPost()
  await ingestImageReply({
    postId, sender: "1", messageId: "m2",
    replyPath: FIXTURES.ticked, caption: "size 90 ya kak",
  })
  const claims = await listClaims(postId)
  assert.ok(claims.every((c) => c.note === "size 90 ya kak"))
})

test("a cropped reply becomes one claim at the matched centre", async () => {
  const { id: postId } = await shelfPost()
  const { claimIds } = await ingestImageReply({
    postId, sender: "2", messageId: "m3",
    replyPath: FIXTURES.crop, caption: "",
  })
  assert.equal(claimIds.length, 1)

  const [claim] = await listClaims(postId)
  assert.equal(claim.source, "crop")
  assert.ok(Math.abs((claim.point?.x ?? 0) - 0.615) < 0.08)
})

test("claims near each other cluster into one slot", async () => {
  const { id: postId } = await shelfPost()
  await ingestImageReply({
    postId, sender: "1", messageId: "a", replyPath: FIXTURES.ticked, caption: "",
  })
  await ingestImageReply({
    postId, sender: "2", messageId: "b", replyPath: FIXTURES.ticked, caption: "",
  })

  const slots = await listSlots(postId)
  // Two customers ticking the same two items: two slots, two claims each.
  assert.equal(slots.length, 2)
  assert.ok(slots.every((s) => s.claimed === 2))
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/whatsapp/ingest.test.ts`
Expected: FAIL — cannot resolve `./ingest`.

- [ ] **Step 3: Implement**

Create `lib/whatsapp/ingest.ts`:

```typescript
import { resolveImageReply, clusterPoints, type Point } from "@/lib/claims"
import { addClaim, getPost, listClaims, setSlots } from "@/lib/db/claims"

/**
 * Turn a customer's image reply into claims.
 *
 * The resolver decides what kind of reply it is; this function only records the
 * outcome. A marked photo yields one claim per mark, because a customer who
 * ticks three things is claiming three things. A crop yields one. A whole photo
 * sent back yields none on its own — the image only says WHICH POST, and the
 * caption carries the request, which is a text claim rather than a positional
 * one and is handled by the caller.
 *
 * Anything the resolver cannot place is still recorded, in review state. A
 * claim that reaches nobody is worse than one the owner has to look at.
 */
export async function ingestImageReply(input: {
  postId: number
  sender: string
  messageId: string
  replyPath: string
  caption: string
}): Promise<{ claimIds: number[] }> {
  const post = await getPost(input.postId)
  if (post === null) throw new Error(`no such post: ${input.postId}`)

  const result = await resolveImageReply(post.imagePath, input.replyPath)
  const claimIds: number[] = []

  const record = async (
    source: "ink" | "crop" | "repost" | "manual",
    point: Point | null,
    confidence: number,
    state: "pending" | "review",
  ) => {
    const { id } = await addClaim({
      postId: input.postId,
      sender: input.sender,
      customer: null,
      source,
      point,
      variantId: null,
      quantity: 1,
      note: input.caption,
      confidence,
      state,
      messageId: input.messageId,
    })
    claimIds.push(id)
  }

  switch (result.kind) {
    case "marks":
      for (const mark of result.marks) await record("ink", mark.point, 1, "pending")
      break
    case "crop": {
      // The margin over the runner-up is the confidence that matters: a narrow
      // one means repeated stock, and the owner should look.
      const margin = result.located.score - result.located.runnerUp
      await record("crop", result.located.centre, margin, margin > 0.15 ? "pending" : "review")
      break
    }
    case "repost":
      // Position-free: the image identified the post, nothing more.
      await record("repost", null, 1, "review")
      break
    case "unresolved":
      await record("manual", null, 0, "review")
      break
  }

  await recluster(input.postId)
  return { claimIds }
}

/**
 * Recompute this post's slots from its claims.
 *
 * Runs after every ingest rather than on a schedule, so the shopping list is
 * correct the moment a claim lands. setSlots carries forward the tally and the
 * named product, so this is safe to call as often as it likes.
 */
export async function recluster(postId: number): Promise<void> {
  const claims = await listClaims(postId)

  const positioned = claims.filter((c) => c.point !== null && c.state !== "rejected")
  const clusters = clusterPoints(positioned.map((c) => c.point as Point))

  const positional = clusters.map((cluster) => ({
    point: cluster.centre,
    variantId: null as string | null,
    claimIds: cluster.members.map((i) => positioned[i].id),
  }))

  // Variant claims have no position, so they group by variant id instead.
  const byVariant = new Map<string, number[]>()
  for (const claim of claims) {
    if (claim.variantId === null || claim.state === "rejected") continue
    const list = byVariant.get(claim.variantId) ?? []
    list.push(claim.id)
    byVariant.set(claim.variantId, list)
  }
  const variantSlots = [...byVariant.entries()].map(([variantId, claimIds]) => ({
    point: null,
    variantId,
    claimIds,
  }))

  await setSlots(postId, [...positional, ...variantSlots])
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS — 54 tests + the 4 new ingest tests.

> If the ingest tests fail on `image_path`, note that `createPost` here stores a
> local filesystem path so the resolver can read it directly. Task 5 of plan 2b
> replaces that with a storage download; the resolver signature does not change.

- [ ] **Step 5: Commit**

```bash
git add lib/whatsapp/ingest.ts lib/whatsapp/ingest.test.ts
git commit -m "feat(whatsapp): turn an image reply into claims

A marked photo yields one claim per mark, because a customer who ticks three
things is claiming three things. A crop yields one, with the margin over the
runner-up as its confidence — a narrow margin means repeated stock and the owner
should look. A whole photo sent back yields a position-free claim in review: the
image identified the post and nothing more.

Nothing is ever dropped for being unresolvable. A claim that reaches nobody is
worse than one the owner has to look at.

Reclustering runs after every ingest rather than on a schedule, so the shopping
list is correct the moment a claim lands; setSlots makes that safe by carrying
the tally and the named product forward."
```

---

### Task 5: Name a slot — product, orders, and the pending tally

**Files:**
- Create: `lib/whatsapp/naming.ts`
- Create: `lib/whatsapp/naming.test.ts`

**Interfaces:**
- Consumes: `computeProductPrice` (`lib/pricing-server`), `addProduct` (`lib/db/catalog`), `appendOrders` (`lib/db/orders`), the data layer from Task 3.
- Produces:
  - `nameSlot(input: { slotId: number; name: string; valas: number; gram: number }): Promise<{ productId: number; orderCount: number }>`

- [ ] **Step 1: Write the failing tests**

Create `lib/whatsapp/naming.test.ts`:

```typescript
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import { FIXTURES } from "../claims/fixtures"
import { createPost, addClaim, setSlots, listSlots } from "../db/claims"
import { nameSlot } from "./naming"

const EVENT = `TESTNAME${Date.now()}`
const HANDLE = `testcust${Date.now()}`

before(async () => {
  await sql`INSERT INTO events (name) VALUES (${EVENT}) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO customers (instagram_id) VALUES (${HANDLE}) ON CONFLICT DO NOTHING`
})

after(async () => {
  await sql`DELETE FROM orders WHERE event = ${EVENT}`
  await sql`DELETE FROM wa_posts WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql`DELETE FROM customers WHERE instagram_id = ${HANDLE}`
  await sql.end()
})

async function slotWithClaims(quantities: number[]) {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: FIXTURES.original, imageWidth: 1600, imageHeight: 2133,
    store: "Nishimatsuya", countryId: null, pricingMethod: "overseas",
    note: "", safeHues: [130],
  })
  const claimIds: number[] = []
  for (const quantity of quantities) {
    const { id } = await addClaim({
      postId, sender: "628111019159", customer: HANDLE, source: "ink",
      point: { x: 0.24, y: 0.78 }, variantId: null, quantity,
      note: "", confidence: 1, state: "pending", messageId: "",
    })
    claimIds.push(id)
  }
  await setSlots(postId, [{ point: { x: 0.24, y: 0.78 }, variantId: null, claimIds }])
  const [slot] = await listSlots(postId)
  return { postId, slot }
}

test("naming creates a product carrying the post's context", async () => {
  const { slot } = await slotWithClaims([1])
  const { productId } = await nameSlot({
    slotId: slot.id, name: `Bunny Pajama ${Date.now()}`, valas: 1699, gram: 250,
  })

  const [product] = await sql`SELECT * FROM products WHERE id = ${productId}`
  assert.equal(product.store, "Nishimatsuya", "store comes from the post, not the typist")
  assert.equal(product.pricing_method, "overseas")
  assert.equal(Number(product.valas), 1699)
  assert.equal(product.gram, 250)
})

test("naming creates one order per claim, at the claimed quantity", async () => {
  const { slot } = await slotWithClaims([1, 2])
  const { orderCount } = await nameSlot({
    slotId: slot.id, name: `Daisy Set ${Date.now()}`, valas: 899, gram: 200,
  })
  assert.equal(orderCount, 2)

  const orders = await sql`SELECT * FROM orders WHERE event = ${EVENT} ORDER BY id DESC LIMIT 2`
  assert.deepEqual(orders.map((o) => o.unit).sort(), [1, 2])
  assert.ok(orders.every((o) => o.customer === HANDLE))
})

test("the slot remembers the product it was named as", async () => {
  const { postId, slot } = await slotWithClaims([1])
  const { productId } = await nameSlot({
    slotId: slot.id, name: `Shawl ${Date.now()}`, valas: 500, gram: 100,
  })
  const [after] = await listSlots(postId)
  assert.equal(after.productId, productId)
})

test("naming twice does not create a second product", async () => {
  const { slot } = await slotWithClaims([1])
  const first = await nameSlot({
    slotId: slot.id, name: `Once ${Date.now()}`, valas: 100, gram: 10,
  })
  await assert.rejects(
    () => nameSlot({ slotId: slot.id, name: "Twice", valas: 100, gram: 10 }),
    /already named/,
    "a named slot must refuse to be named again — orders would be duplicated",
  )
  assert.ok(first.productId > 0)
})

test("a claim with no resolved customer blocks naming rather than losing the order", async () => {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: FIXTURES.original, imageWidth: 1600, imageHeight: 2133,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  const { id: claimId } = await addClaim({
    postId, sender: "62999", customer: null, source: "ink",
    point: { x: 0.5, y: 0.5 }, variantId: null, quantity: 1,
    note: "", confidence: 1, state: "pending", messageId: "",
  })
  await setSlots(postId, [{ point: { x: 0.5, y: 0.5 }, variantId: null, claimIds: [claimId] }])
  const [slot] = await listSlots(postId)

  await assert.rejects(
    () => nameSlot({ slotId: slot.id, name: "Anything", valas: 1, gram: 1 }),
    /unresolved customer/,
  )
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/whatsapp/naming.test.ts`
Expected: FAIL — cannot resolve `./naming`.

- [ ] **Step 3: Implement**

Create `lib/whatsapp/naming.ts`:

```typescript
import sql from "@/lib/db-pool"
import { computeProductPrice } from "@/lib/pricing-server"
import { addProduct } from "@/lib/db/catalog"
import { appendOrders } from "@/lib/db/orders"
import { getPost, listClaims, listSlots } from "@/lib/db/claims"

/**
 * Say what a slot is, and let everything downstream follow.
 *
 * Naming is the moment a position on a photograph becomes a product someone can
 * be invoiced for. It creates one product and one order per claim, at the
 * quantity that customer asked for.
 *
 * Only three fields are typed: name, valas and gram. Store, country, event and
 * pricing method all come from the post, because the owner set them once when
 * posting and re-typing them per item would be fifteen chances to disagree.
 *
 * Price is computed by the same authority the product form uses, so a slot
 * named here and a product added by hand are priced identically.
 */
export async function nameSlot(input: {
  slotId: number
  name: string
  valas: number
  gram: number
}): Promise<{ productId: number; orderCount: number }> {
  const [slotRow] = await sql`SELECT * FROM wa_slots WHERE id = ${input.slotId}`
  if (!slotRow) throw new Error(`no such slot: ${input.slotId}`)

  // Naming twice would create a second product and a second set of orders for
  // customers who already have one. Refuse rather than deduplicate, because the
  // right correction depends on why it happened.
  if (slotRow.product_id !== null) {
    throw new Error(`slot ${input.slotId} is already named`)
  }

  const post = await getPost(slotRow.post_id as number)
  if (post === null) throw new Error(`post missing for slot ${input.slotId}`)

  const claims = (await listClaims(post.id)).filter(
    (c) => c.slotId === input.slotId && c.state !== "rejected",
  )

  // A claim whose sender was never matched to a customer has nobody to invoice.
  // Blocking here keeps the failure visible; creating the product and silently
  // dropping that order would not.
  const unresolved = claims.filter((c) => c.customer === null)
  if (unresolved.length > 0) {
    throw new Error(
      `slot ${input.slotId} has ${unresolved.length} claim(s) with an unresolved customer`,
    )
  }

  const [country] = post.countryId === null
    ? [null]
    : await sql`SELECT kurs, cargo_per_kg FROM countries WHERE id = ${post.countryId}`

  const body = {
    valas: input.valas,
    gram: input.gram,
    kurs: Number(country?.kurs ?? 0),
    cargoPerKg: Number(country?.cargo_per_kg ?? 0),
    price: 0,
    cost: 0,
  }

  return sql.begin(async (tx) => {
    const priced = await computeProductPrice({
      pricingMethod: post.pricingMethod,
      flatFeeMode: "fixed",
      countryId: post.countryId,
      body,
      db: tx,
    })

    const { id: productId } = await addProduct({
      name: input.name.trim(),
      store: post.store,
      price: priced.price,
      gram: input.gram,
      countryId: post.countryId,
      valas: input.valas,
      kurs: body.kurs,
      tieredKurs: priced.tieredKurs,
      cargoPerKg: body.cargoPerKg,
      pricingMethod: post.pricingMethod,
      flatFeeMode: "fixed",
      profitPct: 0,
      operationalFee: 0,
      packingFee: 0,
      cost: priced.cost ?? 0,
      profitFixed: priced.profitFixed ?? 0,
    }, tx)

    await appendOrders(
      claims.map((claim) => ({
        rowNumber: 0,
        event: post.event,
        customer: claim.customer as string,
        productId,
        unitPrice: priced.price,
        unit: claim.quantity,
        note: claim.note,
      })) as Parameters<typeof appendOrders>[0],
      tx,
    )

    await tx`
      UPDATE wa_slots SET product_id = ${productId}, updated_at = NOW()
      WHERE id = ${input.slotId}
    `

    return { productId, orderCount: claims.length }
  })
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS — all previous tests plus 5 naming tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no output.

```bash
git add lib/whatsapp/naming.ts lib/whatsapp/naming.test.ts
git commit -m "feat(whatsapp): name a slot into a product and its orders

Naming is where a position on a photograph becomes something a customer can be
invoiced for. Three fields are typed — name, valas, gram — and store, country,
event and pricing method come from the post, because the owner set them once and
re-typing them per item would be fifteen chances to disagree.

Price goes through computeProductPrice, the same authority the product form
uses, so a slot named here and a product added by hand are priced identically.

Two refusals rather than best-effort behaviour: naming an already-named slot
would duplicate every order behind it, and a claim whose sender was never
matched to a customer has nobody to invoice. Failing loudly beats creating the
product and quietly dropping that person's order."
```

---

## What this plan does not build

- **Any UI.** The posts screen, review queue, annotated shopping list and buy
  tally are plan 2b.
- **API routes.** They arrive with the UI that calls them.
- **Recording the purchase.** Deliberately deferred: once orders exist, the
  existing purchasing path already distributes a bought quantity across them by
  paid priority ([app/api/sheets/purchasing/route.ts](../../../app/api/sheets/purchasing/route.ts)),
  and plan 2b wires the slot tally to it rather than reimplementing it.
- **Anything WhatsApp.** No Baileys, no `/connect`, no reactions — plan 3.

## Open question for plan 2b

`wa_posts.image_path` currently holds whatever path the caller gives it, and the
tests pass a local fixture path so the resolver can read it directly. Plan 2b
must decide where the resolver reads from when the image lives in the bucket:
download to a temp file per reply, or cache the post image on disk beside the
worker. The signature of `resolveImageReply` does not change either way.
