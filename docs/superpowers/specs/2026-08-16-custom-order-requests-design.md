# Custom Order Requests — Design

**Goal:** let a customer request something that is NOT in the catalogue — a
free-text description (optionally with a reference photo) instead of a
tagged product — through the same "request → staff review → convert into a
real order" pipeline the existing catalogue Fix requests already use.

**Relationship to the existing catalogue-order-requests feature:** this
extends it rather than replacing anything. Fix requests (customer taps a
tagged product on a catalogue post) and custom requests (customer describes
something not in the catalogue) become two flavors of the same
`catalogue_requests` row, distinguished by whether `product_id` is set.
Everything downstream of that row — staff review queue, convert/reject,
public status lookup — is shared code with a small branch for the
no-product case, not a parallel system.

## Data Model

`catalogue_requests` (migration, altering the existing table from migration
058 — this branch has already shipped to `development`, so this is a real
migration against a live table, not an edit to an unmerged one):

```sql
ALTER TABLE catalogue_requests
  ALTER COLUMN product_id DROP NOT NULL,
  ADD COLUMN description TEXT NOT NULL DEFAULT '',
  ADD COLUMN reference_image_url TEXT;

ALTER TABLE catalogue_requests
  ADD CONSTRAINT catalogue_requests_product_or_description
  CHECK (product_id IS NOT NULL OR description <> '');
```

- `product_id` — nullable now. NULL means "custom request, no catalogue
  product tagged." Still `REFERENCES products(id) ON DELETE RESTRICT` when
  set — a Fix request's guarantee that its product can't vanish underneath
  it is unchanged.
- `description` — required for a custom request (enforced by the check
  constraint jointly with `product_id`), empty string for a Fix request
  (unused there, matching how `note` already defaults to `''`).
- `reference_image_url` — always nullable; a custom request may or may not
  include a reference photo, a Fix request never has one.
- `note`, `qty`, `status`, `staff_note`, `converted_order_id`,
  `customer_handle` — unchanged, used identically by both request types.

No new table. The existing `catalogue_public` role's column-scoped INSERT
grant (migration 059) needs `description` and `reference_image_url` added
to its column list, same pattern already used for the four existing
columns.

## Reference Photo Upload

The video-catalog site has no multipart-forwarding capability today (its
Netlify Functions only proxy JSON), and building that into a
zero-dependency serverless function is more fragile than necessary. Instead:

```
Browser                          Dashboard                    Supabase Storage
   |  1. POST /api/custom-upload-url    |                             |
   |  (small JSON call, via proxy)      |                             |
   |------------------------------------>|                             |
   |                                     | creates a signed upload URL |
   |                                     |----------------------------->|
   |  { uploadUrl, path }                |                             |
   |<------------------------------------|                             |
   |                                                                    |
   |  2. Uploads the photo bytes directly to Storage using uploadUrl    |
   |------------------------------------------------------------------->|
   |                                                                    |
   |  3. POST /api/public/catalogue/custom-requests                    |
   |  { ..., referenceImageUrl: publicUrlFor(path) }                   |
   |  (small JSON call, via proxy — same as every other submission)    |
   |------------------------------------>|                             |
```

Every call that crosses the video-catalog ↔ dashboard boundary stays plain
JSON, consistent with `netlify/functions/catalogue.js` and `requests.js`.
The actual file bytes go straight from the browser to Supabase Storage,
never through either app's server. The signed-upload-URL endpoint is
public (no session) since it's called by an anonymous customer. Note that
it is directly reachable at its own dashboard URL — a caller can bypass the
video-catalog site (and whatever rate limiting its not-yet-built Netlify
Function proxy layer would eventually add) entirely, e.g. via a plain
`curl`. CORS's `ALLOWED_ORIGIN` only constrains browser-originated requests;
it is not an access control and does nothing against a direct HTTP client.
There is no rate limiting at this layer today — see "Launch Gate: Bot
Mitigation" below, this is a genuine launch blocker, not a nice-to-have.
Even so, a signed URL that
never gets uploaded to, or gets uploaded to but never referenced by a real
`catalogue_requests` row, is inert — an orphaned upload with no request row
costs nothing beyond storage space, the same failure mode
`deleteCatalogueMedia` already exists to (best-effort) clean up for staff
uploads, and worth reusing here too, out of scope for this design to fully
pin down beyond noting the precedent exists.

Size/type caps mirror `lib/storage.ts`'s existing photo cap (5MB,
image/* only — no video for a reference photo, unlike catalogue posts).

## Public API (`inventory-dashboard-v2`)

- `POST /api/public/catalogue/custom-upload-url` — issues the signed
  upload URL described above. No request body needed beyond confirming
  content-type; returns `{ uploadUrl, path }`.
- `POST /api/public/catalogue/custom-requests` — body
  `{ customerHandle, description, qty, note, referenceImageUrl? }`.
  Validates identically to the existing `.../catalogue/requests` POST
  (handle regex, qty bounds, note length) plus: `description` required,
  1-500 chars; `referenceImageUrl`, if present, must actually point into
  the `catalogue-reference` bucket (reject anything else — this endpoint must
  not become an open URL-accepting relay). Calls `createCatalogueRequest`
  with `productId: null`.
- `GET /api/public/catalogue/requests?handle=...` (existing route,
  extended) — each returned request now includes `description` and
  `referenceImageUrl` (both `null`/`""`-equivalent for Fix requests,
  `productName`/`price` `null`-equivalent for custom ones). The video-catalog
  site's status sheet branches on whether `productName` is present.

## Staff Dashboard (`inventory-dashboard-v2`)

**Order Requests list** (`/dashboard/order-requests`): a request with no
`productName` renders its `description` and a "Custom" badge instead of a
product/price line; a `referenceImageUrl` renders as a small thumbnail
(click to view full size, same lightbox-free pattern as elsewhere in this
app — no new component needed, a plain `<a target="_blank">` around an
`<img>` is enough).

**Convert modal**: today it only asks for an event before converting. When
`product_id` is null, it also requires picking an existing product (reusing
whatever product-search component already backs product pickers elsewhere
in the dashboard) before the Convert button is enabled. The chosen product
supplies both the FK and the live price snapshot, same as a normal Fix
conversion.

**`convertCatalogueRequest`** (`lib/db/catalogue-requests.ts`) gains an
optional `productIdOverride` parameter, used only when the request's own
`product_id` is null. If it's null and no override is supplied, the
function throws a clear, user-actionable error (surfaced as 400, not the
generic guard-violation 409 the "already handled" case uses — this is a
different failure mode: "you forgot to pick a product," not a race).

**`PUT /api/sheets/order-requests/[id]`** (existing route, extended): the
convert action's body gains an optional `productId` field, passed through
as the override above.

## Customer Site (`video-catalog`)

**New page**: `public/custom.html` (+ its own small JS module, following
the same no-build, ES-module convention as the rest of the site) — a plain
form: handle (pre-filled from `localStorage`, same key as the rest of the
site), description (textarea), optional photo (file input, drives the
signed-upload-URL flow above before the final submit), qty, note, submit
button. Loading/error states follow the same pattern established
throughout (`res.ok` checked, Indonesian error text, no silent failures).

**Entry point**: a second icon button in the story view's top bar
(`public/index.html`, next to the existing status-lookup receipt icon),
linking to `custom.html`.

**Status sheet** (existing, in `index.html`/`app.js`/`renderer.js`):
`renderStatusList` gains a branch — when a request has no `productName`,
render its `description` (+ a small reference-photo thumbnail if present)
instead of the product/price line, still under the same status badge
(pending/converted/rejected) logic already built.

**Two new Netlify Function proxies**, mirroring the existing pair exactly:
`netlify/functions/custom-upload-url.js` (proxies the signed-URL endpoint)
and reuse of `netlify/functions/requests.js`'s existing POST shape is NOT
appropriate here (different upstream path, different validation) — a
`netlify/functions/custom-requests.js` proxy is added instead, same
caching-none / rate-limited pattern as the existing `requests.js`'s POST
branch.

## Non-Goals

- No change to how Fix requests work — this is purely additive.
- No inline "create a new product" flow inside the Convert modal — if
  staff need a genuinely new product, they create it via the existing
  Products page first, then convert. Keeps this feature from growing into
  a product-management change.
- No video reference uploads, photo only (matches the "reference photo,"
  not "reference media," framing already agreed).
- The signed-upload-URL endpoint has no rate limiting of its own, and
  neither does the video-catalog proxy layer today (it doesn't exist yet).
  An unused signed URL that's never uploaded to, or uploaded to but never
  referenced by a real `catalogue_requests` row, costs nothing beyond
  storage space for an orphaned file (worth a periodic cleanup job
  eventually, explicitly out of scope for this design) — but that doesn't
  cover the endpoint itself being hammered; see "Launch Gate" below.

## Launch Gate: Bot Mitigation (not a "nice to have")

Both new public endpoints — `/api/public/catalogue/custom-upload-url` and
`/api/public/catalogue/custom-requests` — are reachable directly at their
own dashboard URL, completely bypassing whatever rate limiting the
not-yet-built video-catalog Netlify Function proxy layer would eventually
add. `ALLOWED_ORIGIN`/CORS only constrains browser-originated requests; it
is not an access control and does nothing against a direct HTTP client
(e.g. `curl`).

This is a genuine launch blocker, not deferred work to pick up "if abuse
shows up": `custom-upload-url` in particular hands out a real Storage write
capability (a signed upload URL, usable exactly once but with no cap on how
many times it can be requested) to any anonymous caller. That's a stronger
risk than the already-deferred gap on the sibling
`/api/public/catalogue/requests` endpoint (read-only status lookup), since
here an unmitigated caller can mint unlimited write capabilities and fill
the `catalogue-reference` bucket.

Both endpoints need bot mitigation — e.g. Cloudflare Turnstile via the same
`verifyTurnstile` helper `app/api/public/register/route.ts` already uses —
wired in before this feature goes live, not left for a follow-up.
