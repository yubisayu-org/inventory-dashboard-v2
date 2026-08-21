# Photo/Video Catalogue with Customer Order Requests — Design

**Date:** 2026-08-12
**Branch:** `catalogue-order-requests`

## Goal

A public, no-login page where customers browse photos/videos of products and
submit a request ("Fix") for the ones they want, with a qty and an optional
note. Requests land in a staff-reviewed queue and are never written directly
into `orders` — staff converts a request into a real order explicitly, the
same way every order is created today.

## Background (current behavior)

- Public, no-login surfaces already exist and follow a **trusted-gateway**
  pattern: a dedicated, least-privilege Postgres role, a scoped connection
  (`lib/db-public.ts`), and a Next.js API route with its own CORS allowlist.
  - `/api/public/invoice` — reads a customer's order recap by IG handle via
    the `invoice_reader` role (`supabase/migrations/018_invoice_reader_role.sql`),
    column-scoped so PII/bank data is physically unreadable on that connection.
  - `/api/public/register` — a customer registration form (hosted separately,
    on GitHub Pages) posts here; validates and upserts into `customers`.
- `products` (`lib/db/types.ts:464`, `ProductRow`) has no media fields today.
  No file storage of any kind exists in this codebase — the app talks to
  Postgres directly via the `postgres` package (raw SQL, no ORM), and nothing
  imports `@supabase/supabase-js`.
- `orders.customer` is `TEXT NOT NULL REFERENCES customers(instagram_id)`
  (`supabase/migrations/000_init.sql:77`) — but `lib/db/orders.ts:348` and
  `:375` auto-insert a bare `customers (instagram_id)` row when an order
  names a handle that doesn't exist yet (`ON CONFLICT DO NOTHING`, matching
  the Add Order form's `allowNewValue` customer field). So **posting to the
  existing order-creation endpoint already handles a first-time customer** —
  nothing new is needed for that.
- Orders are created via `POST /api/sheets/orders`
  (`app/dashboard/list-order/DataTable.tsx:1166`, `AddOrderForm`), body shape
  `{ rows: [{ event, customer, productId, unitPrice, unit, note }] }`. This is
  the exact shape a converted request needs to produce.
- Customer handles are normalized via `normalizeId` (`lib/db/helpers.ts:8`) —
  lowercase, `@` stripped — the same rule `idx_orders_customer_normalized`
  enforces at the DB level (`supabase/migrations/000_init.sql:93`).

## Decisions

**1. Requests are their own table, never written into `orders`.**

A request has no event, no confirmed pricing, and no place yet in the
dispatch/invoice pipeline that assumes every `orders` row is real and
confirmed. Bolting a speculative pre-order state onto `orders` risks a
forgotten filter somewhere letting an unconverted request leak into shipping
or an invoice. Conversion is an explicit, staff-driven action that calls the
same `POST /api/sheets/orders` endpoint every other order goes through — no
new order-creation code path.

**2. Media is post-centric, not product-centric.**

One photo/video (an IG-story-style single asset) can tag **multiple**
products at once (a haul video, a flat-lay photo). So media lives in its own
table (`catalogue_posts`), joined to `products` many-to-many
(`catalogue_post_products`) — not columns bolted onto `products`.

**3. One request row per product, submitted immediately ("Fix" button).**

No cart. Each tagged product inside a post has its own qty + note + Fix
button; clicking it submits that one request right away. Confirmed via the
brainstorming mockup — simpler to build than cart state, and matches how a
customer actually taps through an IG post.

**4. Staff review is its own dashboard page**, `/dashboard/order-requests` —
not folded into List Order. A request and a confirmed order are different
lifecycles (no event, no pricing snapshot, can be rejected) and mixing them
into one table/page would need the same kind of special-casing rejected in
decision 1, just moved into the UI layer instead of the schema.

**5. File uploads go through `@supabase/supabase-js`, added as a new
dependency, used only for Storage.** The rest of the app deliberately avoids
an ORM/SDK in favor of raw SQL via `postgres`, but Supabase Storage's raw
REST API (multipart upload, signed URLs) is enough boilerplate that
hand-rolling it isn't worth avoiding one focused dependency. The DB access
pattern (raw `postgres`, scoped roles) is unchanged — this is additive, for
file bytes only.

**6. `catalogue_requests.customer_handle` is plain `TEXT`, no FK.** A
customer can submit a request before ever appearing in `customers` (unlike
`orders.customer`, which requires — and self-heals — a `customers` row only
at the point an order is actually created). Requiring the FK earlier would
block a first-time visitor from submitting a request at all.

## Data model — new migration

```sql
-- Posts: one photo/video, optionally tagging several products.
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

-- Requests: one row per customer × product × submission.
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
```

Applied manually in the Supabase SQL editor as the `postgres` owner role,
matching every other migration in this project — the app's own DB role
cannot run DDL.

## New Postgres role — `catalogue_public`

Same shape as `invoice_reader`
(`supabase/migrations/018_invoice_reader_role.sql`): start from zero, grant
only what the public catalogue path needs.

```sql
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM catalogue_public;
GRANT USAGE ON SCHEMA public TO catalogue_public;

GRANT SELECT ON catalogue_posts, catalogue_post_products TO catalogue_public;
-- Public-safe columns only — no cost, profit, or internal pricing fields.
GRANT SELECT (id, name, store, price) ON products TO catalogue_public;

GRANT SELECT, INSERT ON catalogue_requests TO catalogue_public;
GRANT USAGE, SELECT ON catalogue_requests_id_seq TO catalogue_public;
```

Row-scoping for the status lookup (a handle only sees its own requests) is
enforced in the query's `WHERE` clause, not RLS — consistent with this
project's existing direction of deferring RLS in favor of least-privilege
roles. Connected via a new `CATALOGUE_PUBLIC_DATABASE_URL` env var and a
dedicated pool in `lib/db-catalogue-public.ts`, mirroring `lib/db-public.ts`.

## Public routes

All same-origin (served from this app, not a separate site) — no CORS
allowlist needed, unlike `/api/public/invoice`'s cross-domain case.

- **`GET /catalogue`** — the browse page. Server-rendered list of
  `catalogue_posts WHERE visible`, each with its tagged products (name,
  price, thumbnail). Each tagged product: qty input, note field, "Fix"
  button.
- **`POST /api/public/catalogue/requests`** — body
  `{ customerHandle, productId, qty, note? }`. Validates qty is a positive
  integer, caps `note` at 300 characters and `customerHandle` at 30 (matches
  the Instagram handle max already used in
  `app/api/public/register/route.ts:21`), inserts one `catalogue_requests`
  row, returns success. Body-size guard, same shape as the register route
  (`MAX_BODY_BYTES`, `app/api/public/register/route.ts:17`).
- **`GET /api/public/catalogue/requests?handle=`** — status lookup. Returns
  that handle's own requests (product name, qty, note, status, staff_note),
  normalized-matched the same way `idx_orders_customer_normalized` does.

No Turnstile bot-check for the initial version — the registration route's
`verifyTurnstile` (`app/api/public/register/route.ts:53`) is a drop-in if
abuse shows up later; not required to ship this.

## Staff surfaces

**`/dashboard/order-requests`** (new page, standard session+role gate like
every other `/dashboard` page):

- Table of requests, default-filtered to `pending` (same "hide done items"
  convention as the rest of the app).
- **Convert**: opens the request prefilled — customer, product, qty, and its
  `note` mapped onto the order's own `note` field — staff picks the `event`
  (the one field a request never carries) and submits. This calls the
  **same** `POST /api/sheets/orders` the existing Add Order form uses
  (`app/dashboard/list-order/DataTable.tsx:1206`) — no new order-creation
  logic. On success: `UPDATE catalogue_requests SET status = 'converted',
  converted_order_id = <new id>`.
- **Reject**: small modal, optional `staff_note`, sets `status = 'rejected'`.

**`/dashboard/catalogue-posts`** (new page, paired with `/dashboard/order-requests`
but kept separate — content management and request review are different
concerns, matching this app's one-page-per-concern convention): pick a
photo/video file, upload to Supabase Storage via `@supabase/supabase-js`
(decision 5), multi-select which existing products it tags (reusing the
existing item-picker pattern, e.g. `app/dashboard/list-order/DataTable.tsx`'s
`itemOptions`), toggle `visible`.

Sane upload caps: photos ≤ 5MB, videos ≤ 50MB (an IG-story-length clip) —
enforced client-side and re-checked server-side before the Storage call.

## Out of scope

- Cart / multi-item single submission (decision 3 — one-at-a-time only).
- Turnstile / bot mitigation (noted above as a later drop-in).
- Editing or deleting a submitted request as the customer — status lookup is
  read-only.
- A product appearing in more than one post is allowed by the schema
  (`catalogue_post_products` is a true many-to-many) but no UI need for it
  was raised — it falls out for free, not specifically designed for.
- Notifying the customer when their request is converted/rejected (e.g. via
  IG DM) — outside this app's reach; staff follows up manually, same as
  today.
