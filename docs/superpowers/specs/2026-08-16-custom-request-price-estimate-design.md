# Custom Request Price Estimate — Design

**Goal:** let a customer submitting a custom (product-less) order request see
a rough estimated price while filling the form, based on the item's foreign
purchase price and weight — without ever exposing the business's real
exchange rate or freight rate to the browser.

**Relationship to the existing feature:** purely additive to the already-shipped
custom-order-requests backend and its video-catalog frontend counterpart.
Doesn't touch `catalogue_requests`, submission, or conversion — this is a
standalone "preview" calculation the customer can use before submitting.

## Data Model

No schema change. Reuses the existing `countries` table
(`kurs INTEGER`, `cargo_per_kg INTEGER`, already the authority for every
overseas pricing method in the dashboard) and the existing pure pricing
functions in `lib/pricing.ts` (`landedCost`, `calcAbroadPrice`) — the exact
formula the "Profit Margin" product pricing method already uses in
production, applied here with a fixed 15% margin, no operational/packing
fees (those are per-product settings a customer submitting a request has no
way to specify, and don't materially change a rough estimate).

`catalogue_public`'s grants extend to cover `countries`:
```sql
GRANT SELECT (id, name) ON countries TO catalogue_public;
GRANT SELECT (id, name, kurs, cargo_per_kg) ON countries TO catalogue_public;
```
(The second, wider grant supersedes the first for the columns it repeats —
written this way for documentation clarity: "the list page needs id+name,
the estimator additionally needs kurs+cargo_per_kg" — a single combined
grant of all four columns is equally correct and is what actually gets
migrated; see the plan for the exact SQL.)

**Why the raw rate/freight columns are grantable to `catalogue_public` at
all, when the whole point of this feature is to NOT expose them:** the
column grant controls what the DB role *can* read if a query asks for it —
it does not mean every route that uses this role echoes every column back
to the client. The estimate route reads `kurs`/`cargo_per_kg` internally to
compute one number, and that number is the only thing serialized into the
response. This mirrors the exact reasoning already applied to
`products.price` (public) vs `products.cost` (never granted at all,
anywhere) — the difference here is `kurs`/`cargo_per_kg` need to be
*readable* by this connection (to compute with), just never *returned*.

## Public API

- `GET /api/public/catalogue/countries` — no params. Returns
  `{ countries: [{ id: number, name: string }] }`, ordered by name. Powers
  the country dropdown. Never includes `kurs`/`cargo_per_kg`.
- `POST /api/public/catalogue/estimate-price` — body
  `{ countryId: number, valas: number, gram: number }`. Validates all three
  as positive numbers (integer `countryId`, positive `valas`/`gram`),
  looks up the country's `kurs`/`cargo_per_kg` (404 if the country id
  doesn't exist), computes `calcAbroadPrice({ valas, kurs, gram, cargoPerKg,
  profitPct: 15, operationalFee: 0, packingFee: 0, roundTo: 1000 })` from
  the existing `lib/pricing.ts`, and returns
  `{ estimatedPrice: number }` — just the `.price` field, `.cogs` (the raw
  landed cost) is deliberately never included in the response, since that
  number combined with the customer's own known `valas`/`gram` inputs would
  let them algebraically solve for the exact `kurs` used.

Both routes: same CORS/rate-limiting shape as every other public catalogue
route in this codebase (fixed `ALLOWED_ORIGIN`, body-size guard on the POST,
JSON-parse-error returns 400).

## Customer Site (video-catalog)

`public/custom.html` gains three fields between the description and note
fields: a country `<select>` (populated from
`GET /api/custom-countries`, a new proxy), a `valas` number input, a `gram`
number input — plus a read-only "Estimasi: Rp X" line that recalculates
(debounced ~400ms) whenever country/valas/gram all have values, via a new
`POST /api/custom-estimate` proxy. All three fields are optional — a
customer who doesn't know the exact purchase price/weight can still submit
with just a description, same as today; the estimate line simply doesn't
show until all three are filled in.

Two new Netlify Function proxies, mirroring the existing
`custom-requests.js`/`custom-upload-url.js` pair exactly (self-contained,
same rate-limiting shape — `GET /api/custom-countries` needs no rate limit
since it's a static list with no per-call cost or write capability, same
reasoning `catalogue.js`'s GET already uses; `POST /api/custom-estimate`
gets the same 30/60s per-IP limit as the other write-shaped proxies, since
it's still a compute-triggering call even though it writes nothing).

The estimate is explicitly labeled as an estimate (e.g. "Estimasi (bukan
harga final)") — never presented as a firm quote. Staff still set the real
price when converting the request, same as today; this field is purely
informational for the customer at submission time.

## Non-Goals

- No change to `catalogue_requests`'s schema, submission, or conversion —
  the estimate is never stored, never sent as part of the actual request
  submission, purely a client-side preview.
- No support for a customer specifying operational/packing fees — those
  stay staff-only, applied for real only when staff creates the actual
  product/order.
- No live exchange-rate lookups — uses whatever `kurs` is currently stored
  on the `countries` row, exactly like every other pricing method already
  does.
