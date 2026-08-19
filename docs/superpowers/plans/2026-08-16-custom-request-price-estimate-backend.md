# Custom Request Price Estimate (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** let a customer submitting a custom order request see an estimated
price (based on foreign purchase price + weight) without ever exposing the
business's real exchange rate or freight rate to the browser.

**Architecture:** two new public routes reusing the existing `countries`
table and the existing, already-in-production `lib/pricing.ts` formula
(`landedCost`/`calcAbroadPrice`, the same math the "Profit Margin" product
pricing method uses). A narrow `catalogue_public` grant lets the estimate
route read `kurs`/`cargo_per_kg` server-side; neither value is ever
serialized into a response — only the computed estimate is.

**Tech Stack:** Next.js route handlers, `postgres` (raw SQL), the existing
pure functions in `lib/pricing.ts` (no new pricing logic — reused as-is).

**Spec:** `docs/superpowers/specs/2026-08-16-custom-request-price-estimate-design.md`

**Scope note:** this plan covers `inventory-dashboard-v2` only. The
video-catalog site's form fields + proxy functions are a separate follow-up
plan, in that repo.

## Global Constraints

- The estimate response NEVER includes `kurs`, `cargo_per_kg`, or `cogs`
  (landed cost) — only the final `estimatedPrice`. A customer who knows
  their own `valas`/`gram` inputs could algebraically back out `kurs` from
  `cogs`, so `cogs` is excluded from the response even though it's an
  intermediate value `calcAbroadPrice` already computes.
- Public routes: CORS via the same fixed `ALLOWED_ORIGIN` every other
  public catalogue route already uses, body-size guard before parsing on
  the POST route, JSON parse errors return 400, no test framework —
  verification is `tsc`/`build`/manual only.
- Margin is a fixed `profitPct: 15` — not customer-supplied, not
  configurable via the request body (a customer submitting a self-chosen
  margin would defeat the point of an estimate).
- `operationalFee`/`packingFee` are both `0` for this estimate — those are
  per-product staff settings a customer has no way to specify; omitting
  them keeps the estimate a reasonable approximation without needing new
  customer-facing fields for values they'd have to guess at.
- `roundTo: 1000`, matching `calcAbroadPrice`'s own historical default step.

---

### Task 1: Migration — grant `catalogue_public` read access to countries' rate columns

**Files:**
- Create: `supabase/migrations/063_catalogue_public_countries.sql`

**Interfaces:**
- Produces: the grant Task 3's route depends on to query `countries.kurs`/
  `countries.cargo_per_kg`.

- [ ] **Step 1: Write the migration**

```sql
-- Lets the public price-estimate route (app/api/public/catalogue/estimate-price)
-- read a country's real exchange rate and freight rate server-side, to compute
-- an estimate without ever returning those raw numbers to the browser. See
-- docs/superpowers/specs/2026-08-16-custom-request-price-estimate-design.md.
--
-- Column-scoped, same idiom as every other catalogue_public grant in this
-- migration series (059, 061) — id/name/currency/kurs/cargo_per_kg only,
-- nothing else on this table, and no other table gains access here.
GRANT SELECT (id, name, currency, kurs, cargo_per_kg) ON countries TO catalogue_public;
```

- [ ] **Step 2: Apply locally and verify**

Run: `supabase migration up` (or via the local Supabase Studio SQL editor).

```sql
SELECT column_name FROM information_schema.column_privileges
WHERE grantee = 'catalogue_public' AND table_name = 'countries' AND privilege_type = 'SELECT'
ORDER BY column_name;
```
Expected: exactly `cargo_per_kg, currency, id, kurs, name` (5 rows).

Confirm no OTHER table's grants changed:
```sql
SELECT table_name, column_name FROM information_schema.column_privileges
WHERE grantee = 'catalogue_public' AND table_name != 'countries'
ORDER BY table_name, column_name;
```
Expected: unchanged from before this migration — `catalogue_requests` (6
columns from migration 061), `products` (id, name, store, price from
migration 059).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/063_catalogue_public_countries.sql
git commit -m "feat(catalogue): grant catalogue_public read access to countries' rate columns"
```

---

### Task 2: Public route — list countries

**Files:**
- Create: `app/api/public/catalogue/countries/route.ts`

**Interfaces:**
- Consumes: `catalogueSql` (existing, `@/lib/db-catalogue-public`).
- Produces: `GET /api/public/catalogue/countries` →
  `{ countries: [{ id: number, name: string }] }`. The video-catalog site's
  future country dropdown is the intended caller; this task verifies it
  standalone with curl.

- [ ] **Step 1: Write the route**

```typescript
import { NextResponse } from "next/server"
import catalogueSql from "@/lib/db-catalogue-public"

// Public, no-login endpoint listing countries for the custom-request price
// estimator's country picker. Only id/name — kurs/cargo_per_kg are never
// exposed here (see estimate-price/route.ts, which uses them server-side
// only). See docs/superpowers/specs/2026-08-16-custom-request-price-estimate-design.md.
//
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
    const rows = await catalogueSql`SELECT id, name FROM countries ORDER BY name`
    const countries = rows.map((r) => ({ id: r.id as number, name: r.name as string }))
    return NextResponse.json(
      { countries },
      { headers: { ...corsHeaders(), "Cache-Control": "public, max-age=60" } },
    )
  } catch (err) {
    console.error("Failed to load countries:", err)
    return NextResponse.json(
      { error: "Failed to load countries" },
      { status: 500, headers: corsHeaders() },
    )
  }
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` — expect no new errors.

```bash
curl -s -w "\nHTTP %{http_code}\n" http://localhost:3001/api/public/catalogue/countries
```
Expected: `200`, body `{"countries":[{"id":1,"name":"..."},...]}` — real
country rows, alphabetically ordered, no `kurs`/`cargo_per_kg`/`currency`
fields present in the response.

- [ ] **Step 3: Commit**

```bash
git add app/api/public/catalogue/countries/route.ts
git commit -m "feat(catalogue): public endpoint to list countries for the price estimator"
```

---

### Task 3: Public route — estimate price

**Files:**
- Create: `app/api/public/catalogue/estimate-price/route.ts`

**Interfaces:**
- Consumes: `catalogueSql` (existing), `landedCost`/`calcAbroadPrice`
  (existing, `@/lib/pricing.ts` — do not modify that file, import from it).
- Produces: `POST /api/public/catalogue/estimate-price` (body:
  `{countryId, valas, gram}`) → `{estimatedPrice: number}` on success.

- [ ] **Step 1: Write the route**

```typescript
import { NextRequest, NextResponse } from "next/server"
import catalogueSql from "@/lib/db-catalogue-public"
import { calcAbroadPrice } from "@/lib/pricing"

// Public, no-login endpoint estimating a price for a custom order request,
// from a foreign-currency purchase price and weight. Computes server-side
// using the country's real kurs/cargo_per_kg (readable by this connection
// per migration 063, never included in the response) and the same
// calcAbroadPrice formula the "Profit Margin" product pricing method
// already uses in production — fixed 15% margin, no fees. Returns ONLY the
// final price: `.cogs` (landed cost) is deliberately never returned, since
// a caller who knows their own valas/gram could otherwise back out kurs.
// See docs/superpowers/specs/2026-08-16-custom-request-price-estimate-design.md.
//
// TODO: swap for the real domain once the catalogue site is deployed.
const ALLOWED_ORIGIN = "https://yubisayu-catalogue.netlify.app"

const MAX_BODY_BYTES = 1024
const PROFIT_PCT = 15
const ROUND_TO = 1000

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

  try {
    const b = body as Record<string, unknown>
    const countryId = Number(b.countryId)
    const valas = Number(b.valas)
    const gram = Number(b.gram)

    if (!Number.isInteger(countryId) || countryId < 1) {
      return NextResponse.json({ error: "countryId must be a positive integer" }, { status: 400, headers: corsHeaders() })
    }
    if (!Number.isFinite(valas) || valas <= 0) {
      return NextResponse.json({ error: "valas must be a positive number" }, { status: 400, headers: corsHeaders() })
    }
    if (!Number.isFinite(gram) || gram <= 0) {
      return NextResponse.json({ error: "gram must be a positive number" }, { status: 400, headers: corsHeaders() })
    }

    const [country] = await catalogueSql`
      SELECT kurs, cargo_per_kg FROM countries WHERE id = ${countryId}
    `
    if (!country) {
      return NextResponse.json({ error: "Country not found" }, { status: 404, headers: corsHeaders() })
    }

    const { price } = calcAbroadPrice({
      valas,
      kurs: country.kurs as number,
      gram,
      cargoPerKg: country.cargo_per_kg as number,
      profitPct: PROFIT_PCT,
      operationalFee: 0,
      packingFee: 0,
      roundTo: ROUND_TO,
    })

    return NextResponse.json({ estimatedPrice: price }, { headers: corsHeaders() })
  } catch (err) {
    console.error("Failed to estimate price:", err)
    return NextResponse.json({ error: "Failed to estimate price" }, { status: 500, headers: corsHeaders() })
  }
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` — expect no new errors.

Using a real country id from Task 2's response:
```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:3001/api/public/catalogue/estimate-price \
  -H "Content-Type: application/json" \
  -d '{"countryId":1,"valas":100,"gram":500}'
```
Expected: `200 {"estimatedPrice":<some positive number, a multiple of 1000>}`.
Confirm the response body has ONLY the `estimatedPrice` key — no `cogs`, no
`kurs`, no `cargoPerKg`.

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:3001/api/public/catalogue/estimate-price \
  -H "Content-Type: application/json" \
  -d '{"countryId":999999,"valas":100,"gram":500}'
```
Expected: `404 {"error":"Country not found"}`.

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST http://localhost:3001/api/public/catalogue/estimate-price \
  -H "Content-Type: application/json" \
  -d '{"countryId":1,"valas":-5,"gram":500}'
```
Expected: `400`, error mentions valas must be positive.

Cross-check the math by hand for one real country: query
`SELECT kurs, cargo_per_kg FROM countries WHERE id = 1` directly via the
local Supabase connection (not through the public role — use the normal
`postgres:postgres@127.0.0.1:54322` local superuser connection for this
one-off check), then compute
`cogs = 100*kurs + (500/1000)*cargoPerKg`,
`price = ceil((cogs*100/(100-15) + 0 + 0) / 1000) * 1000`, and confirm it
matches the route's `estimatedPrice` exactly.

- [ ] **Step 3: Commit**

```bash
git add app/api/public/catalogue/estimate-price/route.ts
git commit -m "feat(catalogue): public endpoint to estimate a custom request's price"
```

---

### Task 4: End-to-end verification

No automated test suite exists — full manual pass against the local dev
stack.

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed with zero errors.

- [ ] **Step 2: Confirm the grant is genuinely least-privilege**

Re-run Task 1 Step 2's two verification queries once more, on the final
state after Tasks 2-3 (nothing in those tasks should have changed the
grant, but confirm nothing accidentally widened it).

- [ ] **Step 3: Full round trip**

```bash
curl -s http://localhost:3001/api/public/catalogue/countries
```
Pick a real `id` from the response. Then:
```bash
curl -s -X POST http://localhost:3001/api/public/catalogue/estimate-price \
  -H "Content-Type: application/json" \
  -d '{"countryId":<that id>,"valas":250,"gram":300}'
```
Expected: `{"estimatedPrice": <number>}`, and manually confirm the number is
plausible (not zero, not absurdly large — sanity-check against a real
product's price for that country if one exists, they should be in a
comparable order of magnitude for a similar valas/gram).

- [ ] **Step 4: Final commit (if any fixes were needed)**

If any step required a code fix, commit it individually with a clear
message. If everything passed as-built, nothing to commit.

---

## Self-Review

**1. Spec coverage:** Grant (Task 1), country list endpoint (Task 2),
estimate endpoint reusing the existing pricing formula and never leaking
`kurs`/`cargo_per_kg`/`cogs` (Task 3) — all spec sections covered. The
video-catalog frontend counterpart is explicitly out of scope per this
plan's own header and the spec's repo-boundary note.

**2. Placeholder scan:** No "TBD"/"TODO" in any task body (the `// TODO:
swap for the real domain` comments are the same intentional, established
pattern every other public catalogue route in this codebase already uses).

**3. Type consistency:** `calcAbroadPrice`'s input shape
(`{valas, kurs, gram, cargoPerKg, profitPct, operationalFee, packingFee,
roundTo}`) and output shape (`{cogs, price}`) match `lib/pricing.ts`'s
actual, already-shipped signature exactly (verified by reading the file
before writing this plan, not assumed). Task 3's route destructures only
`price`, matching the Global Constraints' explicit rule that `cogs` is
never returned.

**4. Scope check:** One cohesive backend addition (grant → list endpoint →
estimate endpoint), sequentially dependent, appropriately one plan.
