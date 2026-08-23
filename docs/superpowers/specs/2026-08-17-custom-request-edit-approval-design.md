# Custom Request Edit & Customer Approval — Design

**Goal:** let the owner (owner-only, not staff) revise the country/valas/gram
on a pending custom order request, have the price re-estimate, and require
the customer to approve that revised price before the owner can convert the
request into a real order — closing the gap where today a custom request can
only be converted as-is or rejected outright, with no negotiation step.

**Relationship to prior work:** builds directly on the already-shipped
custom-order-requests feature (customer-facing custom request submission +
live price estimate) and the `catalogue_requests` table it created. Reuses
`lib/pricing.ts`'s `calcAbroadPrice` (same formula, same fixed 15% margin,
no fees) that both the customer-facing estimator and every "Profit Margin"
product already use — no new pricing logic.

## Non-Goals

- No push notification to the customer (WhatsApp/email/SMS) when an offer is
  ready. Confirmed during design: no such channel exists anywhere in this
  codebase today (only manual, staff-clicked `wa.me` deep links). The
  customer finds a revised offer by re-checking the existing public
  status-lookup page, same as today.
- No multi-round revision history. One active proposal at a time; the owner
  re-editing while `offer_pending` overwrites the prior proposal in place.
  No separate offers/history table.
- No server-side enforcement that a converted order's price matches
  `estimated_price` if the owner manually picks an existing product instead
  of using the new prefilled "Create Product" shortcut (see below) — the
  prefill is what keeps them consistent by default; a deliberate mismatch
  remains possible and is the owner's call, not blocked.
- **Reopens a prior explicit Non-Goal, narrowly.** The original
  custom-order-requests spec states: *"No inline 'create a new product' flow
  inside the Convert modal — if staff need a genuinely new product, they
  create it via the existing Products page first, then convert."* This
  design reintroduces exactly that, but only reachable from an `approved`
  custom request that already carries an owner-set, customer-approved price
  — not a general "create product from Convert" shortcut for every request.
- No change to the non-custom (product-backed) request flow. Edit/approval
  only applies to custom requests (`product_id IS NULL`).

## State Machine

```
pending ──(owner: Edit)──> offer_pending ──(customer: Approve)──> approved ──(owner)──> converted
   │                            │                                     │
   │                            ├──(customer: Reject)──> rejected     └──(owner)──> rejected
   │                            └──(owner: Cancel)──> pending
   └──(owner, unchanged today)──> converted / rejected directly
```

- `offer_pending`: owner has proposed a country/valas/gram revision;
  awaiting the customer. Convert/Reject are unavailable in this state — the
  owner must wait for the customer's answer, or Cancel to withdraw the
  proposal (e.g. a typo) back to `pending` without asking the customer to
  reject it.
- `approved`: customer accepted. Functionally like `pending` for the owner
  (Convert/Reject both still available) but the UI shows "customer approved
  ✓" plus the confirmed country/valas/gram/price, and the new "Create
  Product" shortcut becomes available.
- Customer rejecting a revision goes straight to `rejected` (terminal) —
  same end state as today's staff-initiated reject. No further negotiation
  round.
- Today's direct `pending` → `converted`/`rejected` path (no revision) is
  unchanged — Edit is optional, not mandatory, on every custom request.

## Data Model

Four new nullable columns on `catalogue_requests`:

| Column | Type | Notes |
|---|---|---|
| `country_id` | `INTEGER REFERENCES countries(id) ON DELETE SET NULL` | Set by Edit, cleared by Cancel |
| `valas` | `NUMERIC` | |
| `gram` | `NUMERIC` | |
| `estimated_price` | `INTEGER` | Output of `calcAbroadPrice`, flat `roundTo = 1000` — same as any other "Profit Margin" product, NOT the public customer-facing estimator's relative-precision rounding (that hardening exists only because the public estimator is an unauthenticated, repeatedly-queryable oracle surface; this value is computed once by an authenticated owner action and then stored/returned as-is, so there's nothing to protect against) |

`status` CHECK extended: `'pending' \| 'offer_pending' \| 'approved' \| 'converted' \| 'rejected'`.

No history table — re-editing while `offer_pending` overwrites these four
columns in place, still `offer_pending`.

`catalogue_public`'s existing grant on `catalogue_requests` extends to:
`SELECT` on the four new columns (for the public status-lookup response),
plus a new, narrowly scoped `UPDATE (status)` permission — enforced by the
app's guarded `WHERE status = 'offer_pending'` on both new public
transition routes, not by column-level grants alone.

## API Surface

**Owner-authenticated** (`requireOwner()`, existing pattern):

- `PUT /api/sheets/order-requests/[id]` — `action` gains two values:
  - `"edit"` — body `{countryId, valas, gram}`. Server computes
    `estimated_price` via `calcAbroadPrice` using the country's real
    `kurs`/`cargo_per_kg` (owner-authenticated, direct DB access — no
    oracle concern, this isn't the public estimator), fixed 15% margin, no
    fees, flat `roundTo = 1000` (see Data Model — not the public
    estimator's relative-precision rounding). Guarded:
    `WHERE id = ... AND status = 'pending'` → `offer_pending`. 409 if not
    currently `pending`.
  - `"cancel-edit"` — clears the four columns, guarded
    `WHERE status = 'offer_pending'` → `pending`.
  - `"convert"`/`"reject"` — unchanged, guard widened to
    `WHERE status IN ('pending', 'approved')` (excludes `offer_pending`).
- New read-only route for the Edit modal's live price preview as the owner
  types (owner-only, no state change): given `{countryId, valas, gram}`,
  returns `{estimatedPrice}` computed the same way as the `"edit"` action.

**Public** (`catalogue_public` role, same trust model as the rest of this
feature — scoped by `customerHandle` + request `id`, both already visible
to the customer from the status-lookup response):

- `POST /api/public/catalogue/requests/[id]/approve` — body
  `{customerHandle}`. Guarded
  `UPDATE ... WHERE id = ... AND customer_handle = ... AND status = 'offer_pending'`
  → `approved`. Race-safe like the existing convert/reject guards. 409 if
  already resolved.
- `POST /api/public/catalogue/requests/[id]/reject` — same shape → `rejected`.
- Existing `GET /api/public/catalogue/requests?handle=` response extends to
  include, when set: country **name** (never `kurs`/`cargo_per_kg` — same
  column-selection discipline as the existing public countries/estimate
  routes), `valas`, `gram`, `estimated_price`. `status` now may also be
  `offer_pending`/`approved`.
- Both new public routes get the same lightweight per-IP rate limiting
  already standard on every public catalogue route in this feature — not
  oracle-grade hardening (there's no secret being computed here, just a
  guarded state transition), just consistency with the established pattern.

## Owner Experience

On a `pending` custom request: new **Edit** action (alongside today's
Convert/Reject) opens a modal — country picker + valas + gram inputs, same
three fields as the customer-facing estimator, with a debounced live price
preview. Submitting calls `"edit"`, moving the request to `offer_pending`.

While `offer_pending`: Convert/Reject are hidden; **Cancel** is shown
instead, reverting to `pending`.

Once `approved`: the confirmed country/valas/gram/price are shown, plus a
new **Create Product** action. This opens the existing product-creation
form, pre-filled with: name defaulted from the request's `description`
(owner may edit it), the approved `country_id`/`valas`/`gram`, profit fixed
at 15%, and — the key requirement — **the price field defaults to the
approved `estimated_price` exactly, not recomputed from the country's live
kurs at product-creation time**, so the eventual order's price matches what
the customer approved even if the exchange rate has moved since. The owner
may still manually edit the price before saving, same as any other product
field. After saving, the owner proceeds through the existing Convert modal
and picks the newly created product, same mechanics as today's "map a
custom request to a real product" step — no change to `convertCatalogueRequest`
itself. Convert/Reject remain available on an `approved` request without
using Create Product too, for the case where an existing product already
matches.

## Customer Experience

The existing public status-lookup page (video-catalog site, checked by
handle) renders a new state: when a request is `offer_pending`, it shows
the owner's proposed country/valas/gram/estimated price, clearly labeled as
a revision from the owner (distinct from the customer's original request),
with **Approve** / **Reject** buttons. These call two new Netlify proxies
(mirroring the existing `custom-estimate.js` proxy pattern) to the two new
public dashboard routes above.

No new notification mechanism — the customer must return to the status page
to see it, exactly like checking on any other request today.
