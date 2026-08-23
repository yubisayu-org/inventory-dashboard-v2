# Claim Capture: SKU Slots and the Rekap Picture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a post's claims into per-size SKU slots, record what was actually bought against individual claims, and render the annotated shopping-list picture the owner asked for — reachable as a URL, with no dashboard pages yet.

**Architecture:** Sizes become real slot rows rather than free text read at buy time, which makes a two-size shelf item two SKUs everywhere: two badges, two rows in the list, two products at naming. `bought` stops being a number on the slot and becomes the sum of what individual claims obtained, so the owner's ✅ reaction in the group and the stepper in the shop write the same field and cannot disagree. The picture is rendered server-side with `sharp` from the stored post image plus its slots.

**Tech Stack:** TypeScript, `postgres` (postgres.js), `sharp`, Next.js 16 route handlers, `node:test` via `tsx`.

**Spec:** [docs/superpowers/specs/2026-08-16-whatsapp-claim-capture-design.md](../specs/2026-08-16-whatsapp-claim-capture-design.md)

**Depends on:** [2026-08-16-claim-resolvers.md](2026-08-16-claim-resolvers.md) and [2026-08-16-claim-capture-backend.md](2026-08-16-claim-capture-backend.md) — both complete.

## What this plan is not

The two dashboard pages are a separate plan. This one ends at an API that returns
the finished picture, which is the deliverable the owner chose and which can be
looked at in a browser without any UI existing. The laptop review page and the
stripped shop page follow in plan 2c, and they consume exactly the routes built
in Task 6.

## Decisions already made

Settled with the owner on 2026-08-16 and 2026-08-17. Do not relitigate mid-build.

- **The picture is "B+L".** A badge on each slot showing **how many are still to
  buy** — not `bought/claimed` — with a tick when the slot is finished. The
  per-size breakdown goes in a printed list under the photo, not stacked on the
  badge.
- **Counted in SKU, not slots.** Six items on a shelf where two split by size is
  eight SKU. That vocabulary appears in the rendered picture and in the API.
- **A slot carries a working name** — free text, typed once, creating no product
  and no orders. It exists so a list reads "Brown Bear Set" instead of "Slot 4".
  Real naming still happens later and is what creates a product.
- **The owner reacting ✅ on a claim in the group means that claim was bought.**
  Therefore `bought` is per-claim, and the slot's figure is derived.
- **Allocation when short reuses `compareOrderPriority`** — paid, then partly
  paid, then unpaid — the same rule arrivals already use.
- **Posts originate in WhatsApp**, inside a capture window the owner opens with a
  command that also carries the store name.

## Global Constraints

- Node `22.x` per `package.json` `engines`.
- Migrations start at **064**. `supabase migration up` does **not** work on this
  branch — the local DB carries 058-060 from `catalogue-order-requests` which do
  not exist here — so migrations are applied by piping to psql, exactly as 061,
  062 and 063 were:
  ```bash
  PSQL=psql; [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
  "$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f <file>
  ```
- Money is INTEGER rupiah. Positions are normalized 0..1 doubles.
- Imports are extensionless (`./size`, not `./size.ts`) — `.ts` specifiers fail
  `tsc` under this tsconfig.
- Tests run with `npm test`, which already globs `lib/*.test.ts`,
  `lib/claims/*.test.ts`, `lib/db/*.test.ts` and `lib/whatsapp/*.test.ts` and
  loads `.env.development.local`.
- `events.warehouse_id` is NOT NULL, so test fixtures that insert an event must
  supply one:
  ```sql
  INSERT INTO events (name, warehouse_id)
  SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
  ON CONFLICT DO NOTHING
  ```
- Tests must delete every `products` row they create. The dev database is never
  reset and junk accumulates.
- Comments explain *why*, at the density of `lib/db/fulfillment.ts`.

---

### Task 1: Reading a size out of a claim's note

**Files:**
- Create: `lib/claims/size.ts`
- Create: `lib/claims/size.test.ts`
- Modify: `lib/claims/index.ts` (add the re-export)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normalizeSize(note: string): string` — `"size 90 ya kak"` → `"90"`, `"mau yg L"` → `"L"`, `""` when the note names no size.

A shelf photo has no declared variant list, so the spec stores the customer's
note raw. That stays true — this function does not rewrite the note. It reads a
size *out* of it so claims wanting the same size can be grouped, and returns
empty when it is not confident, which puts those claims in an unsized slot the
owner can see and split by hand.

- [ ] **Step 1: Write the failing test**

Create `lib/claims/size.test.ts`:

```typescript
import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeSize } from "./size"

test("a numeric size is found however it is introduced", () => {
  assert.equal(normalizeSize("size 90"), "90")
  assert.equal(normalizeSize("ukuran 100"), "100")
  assert.equal(normalizeSize("uk 80 ya kak"), "80")
  assert.equal(normalizeSize("yg bear itu size 95 ya kak, 1 aja"), "95")
  assert.equal(normalizeSize("90"), "90")
  assert.equal(normalizeSize("90cm"), "90")
})

test("letter sizes are recognised and upper-cased", () => {
  assert.equal(normalizeSize("mau yg L"), "L")
  assert.equal(normalizeSize("size xl"), "XL")
  assert.equal(normalizeSize("ukuran XXL dong"), "XXL")
})

test("a quantity is never mistaken for a size", () => {
  // "2" is how many they want, not what size. Baby-clothes sizes start at 50.
  assert.equal(normalizeSize("mau 2"), "")
  assert.equal(normalizeSize("2 ya kak"), "")
  assert.equal(normalizeSize("ambil 3"), "")
})

test("a number outside the clothing range is not a size", () => {
  assert.equal(normalizeSize("harga 1699"), "")
  assert.equal(normalizeSize("yg 200"), "")
})

test("nothing recognisable yields nothing, not a guess", () => {
  assert.equal(normalizeSize(""), "")
  assert.equal(normalizeSize("mau kak"), "")
  assert.equal(normalizeSize("yang itu ya"), "")
})

test("the first size wins when a note mentions two", () => {
  // "90 atau 95" is a customer hedging. The first is what they asked for; the
  // owner sees the raw note and can move the claim if the hedge mattered.
  assert.equal(normalizeSize("90 atau 95"), "90")
})

test("a bare letter that is really a word is not a size", () => {
  // "l" inside a word must not read as size L.
  assert.equal(normalizeSize("lucu banget"), "")
  assert.equal(normalizeSize("mau kalau ada"), "")
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx tsx --test lib/claims/size.test.ts`
Expected: FAIL — cannot resolve `./size`.

- [ ] **Step 3: Implement**

Create `lib/claims/size.ts`:

```typescript
/**
 * Smallest and largest numbers that can plausibly be a clothing size here.
 *
 * The catalogue is Japanese baby and children's wear, sized in centimetres:
 * 50 through 160. The floor matters more than the ceiling — without it every
 * "mau 2" reads as size 2, and a quantity would silently become a variant.
 */
const MIN_NUMERIC_SIZE = 50
const MAX_NUMERIC_SIZE = 160

/** Letter sizes, longest first so XXL is matched before XL and XL before L. */
const LETTER_SIZES = ["XXXL", "XXL", "XL", "S", "M", "L"] as const

/**
 * Read a size out of a customer's note.
 *
 * Returns "" whenever nothing is clearly a size. That is a deliberate answer
 * rather than a failure: claims with no size group into one unsized slot, which
 * is visible on the shopping list and can be split by hand. Guessing would put
 * someone's order under a size they never asked for.
 *
 * The note itself is never modified — see the spec's "Shelf claims carry free
 * text". This only decides which slot the claim belongs to.
 */
export function normalizeSize(note: string): string {
  const text = note.toLowerCase()

  // Numbers first: they are unambiguous once the range filter has run, whereas
  // a stray "l" inside a word is not.
  for (const match of text.matchAll(/\d+/g)) {
    const value = Number(match[0])
    if (value >= MIN_NUMERIC_SIZE && value <= MAX_NUMERIC_SIZE) return String(value)
  }

  // Letters must stand alone. Word boundaries stop "lucu" reading as L and
  // "kalau" reading as... nothing in particular, but the same rule covers both.
  for (const size of LETTER_SIZES) {
    if (new RegExp(`(^|[^a-z])${size.toLowerCase()}([^a-z]|$)`).test(text)) return size
  }

  return ""
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx tsx --test lib/claims/size.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Re-export it**

In `lib/claims/index.ts`, add beside the other re-exports (after the `cluster`
line, keeping the file's existing grouping):

```typescript
export { normalizeSize } from "./size"
```

- [ ] **Step 6: Commit**

```bash
git add lib/claims/size.ts lib/claims/size.test.ts lib/claims/index.ts
git commit -m "feat(claims): read a size out of a claim's note

Returns empty whenever nothing is clearly a size, which is an answer rather than
a failure: unsized claims group into one slot the owner can see and split, where
a guess would file someone's order under a size they never asked for.

Numbers are only sizes inside 50-160, the range this catalogue actually uses.
Without that floor every \"mau 2\" reads as size 2 and a quantity silently
becomes a variant. Letter sizes must stand alone so \"lucu\" is not an L.

The note itself is untouched — the spec keeps shelf text raw, and this only
decides which slot a claim belongs to."
```

---

### Task 2: Migration 064 — SKU slots and per-claim buying

**Files:**
- Create: `supabase/migrations/064_wa_sku_slots.sql`
- Modify: `lib/db/claims.ts`
- Modify: `lib/db/claims.test.ts`

**Interfaces:**
- Consumes: `fetchPaidStatusMap`, `compareOrderPriority` from `lib/db/shopping-list`; `allocateFifo` from `lib/fifo-fill`.
- Produces:
  - `WaSlot` gains `label: string` and `size: string`; `bought` is now derived.
  - `setSlots(postId, slots)` where a slot is `{ point, variantId, size, claimIds }`.
  - `setSlotLabel(slotId: number, label: string): Promise<void>`
  - `setSlotBought(slotId: number, bought: number): Promise<void>` — now allocates across claims by paid priority.
  - `markClaimObtained(claimId: number, obtained: number): Promise<void>`

This is the task that changes shipped code. Plan 2a stored `bought` as one
integer on the slot, before the owner decided that a ✅ reaction on a claim
counts as buying it. Two inputs writing one number is how they end up
disagreeing, so the number moves onto the claim and the slot derives its total —
the same way `claimed` already works.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/064_wa_sku_slots.sql`:

```sql
-- SKU slots, and buying recorded against individual claims.
--
-- Two changes that belong together.
--
-- A shelf item that three people want in 90 and two want in 95 is two things to
-- pick up, two products at naming, and two lines on the shopping list. So size
-- moves out of the claim's free text and onto the slot, and a position on the
-- photograph can now carry more than one slot.
--
-- And `bought` moves from the slot onto the claim. The owner reacts to a
-- customer's message with a tick as the item goes in the basket, which says
-- exactly WHO got one — strictly more than a count does. The stepper in the shop
-- still records a bare number, but it now spends that number across the claims
-- by payment priority rather than storing it somewhere else. One field, two ways
-- in, nothing to reconcile.

-- Working name. Not the product name: naming a slot creates a product and the
-- orders behind it, which is a much later and much heavier act. This exists so a
-- list can say "Brown Bear Set" instead of "Slot 4" while shopping.
ALTER TABLE wa_slots ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';

-- Empty means "nobody said a size", which is a real and common state, not a
-- missing value. Those claims group together and the owner splits them by hand
-- if it turns out to matter.
ALTER TABLE wa_slots ADD COLUMN IF NOT EXISTS size TEXT NOT NULL DEFAULT '';

-- How many of THIS claim were obtained. Zero until something says otherwise.
ALTER TABLE wa_claims ADD COLUMN IF NOT EXISTS obtained INTEGER NOT NULL DEFAULT 0;

-- Carry the old per-slot tallies onto the claims before the column goes, so a
-- database that already has counts does not lose them. Spread by claim id,
-- which is arrival order — the same tie-break compareOrderPriority falls back to.
DO $$
DECLARE
  slot RECORD;
  claim RECORD;
  remaining INTEGER;
  give INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'wa_slots' AND column_name = 'bought'
  ) THEN
    RETURN;
  END IF;

  FOR slot IN SELECT id, bought FROM wa_slots WHERE bought > 0 LOOP
    remaining := slot.bought;
    FOR claim IN
      SELECT id, quantity FROM wa_claims
      WHERE slot_id = slot.id AND state <> 'rejected'
      ORDER BY id ASC
    LOOP
      EXIT WHEN remaining <= 0;
      give := LEAST(claim.quantity, remaining);
      UPDATE wa_claims SET obtained = give WHERE id = claim.id;
      remaining := remaining - give;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE wa_slots DROP COLUMN IF EXISTS bought;

-- One slot per position per size. Without this a re-cluster that produced two
-- sizes at the same centre could write two rows that later match each other
-- when bought/product are carried forward.
CREATE INDEX IF NOT EXISTS idx_wa_slots_post_size ON wa_slots (post_id, size);
```

- [ ] **Step 2: Apply it and confirm the shape changed**

```bash
PSQL=psql; [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
"$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/064_wa_sku_slots.sql
"$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d wa_slots" -c "\d wa_claims"
```

Expected: `wa_slots` has `label` and `size` and no longer has `bought`;
`wa_claims` has `obtained`.

- [ ] **Step 3: Write the failing tests**

In `lib/db/claims.test.ts`, replace the existing
`"re-clustering preserves what a slot already knows"` test with the three below,
and add the new import line at the top:

```typescript
import { createPost, getPost, addClaim, listClaims, setSlots, listSlots, setSlotBought, setSlotLabel, markClaimObtained } from "./claims"
```

```typescript
test("re-clustering preserves what a slot already knows", async () => {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: "test/c.jpg", imageWidth: 100, imageHeight: 100,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  const first = await addClaim({
    postId, sender: "1", customer: null, source: "ink", point: { x: 0.5, y: 0.5 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  await setSlots(postId, [
    { point: { x: 0.5, y: 0.5 }, variantId: null, size: "90", claimIds: [first.id] },
  ])

  const [slot] = await listSlots(postId)
  await setSlotLabel(slot.id, "Brown Bear Set")
  await setSlotBought(slot.id, 1)

  // A later claim arrives and clustering runs again over the same position.
  const second = await addClaim({
    postId, sender: "2", customer: null, source: "ink", point: { x: 0.51, y: 0.5 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  await setSlots(postId, [
    { point: { x: 0.505, y: 0.5 }, variantId: null, size: "90", claimIds: [first.id, second.id] },
  ])

  const reclustered = await listSlots(postId)
  assert.equal(reclustered.length, 1)
  assert.equal(reclustered[0].label, "Brown Bear Set", "a name typed in the shop must survive")
  assert.equal(reclustered[0].bought, 1, "a tally made in the shop must survive re-clustering")
  assert.equal(reclustered[0].claimed, 2)
})

test("two sizes at one position are two slots that do not swap identities", async () => {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: "test/d.jpg", imageWidth: 100, imageHeight: 100,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  const small = await addClaim({
    postId, sender: "1", customer: null, source: "ink", point: { x: 0.5, y: 0.5 },
    variantId: null, quantity: 1, note: "size 90", confidence: 1, state: "pending", messageId: "",
  })
  const large = await addClaim({
    postId, sender: "2", customer: null, source: "ink", point: { x: 0.5, y: 0.5 },
    variantId: null, quantity: 1, note: "size 95", confidence: 1, state: "pending", messageId: "",
  })

  await setSlots(postId, [
    { point: { x: 0.5, y: 0.5 }, variantId: null, size: "90", claimIds: [small.id] },
    { point: { x: 0.5, y: 0.5 }, variantId: null, size: "95", claimIds: [large.id] },
  ])
  const slots = await listSlots(postId)
  assert.equal(slots.length, 2)

  const ninety = slots.find((s) => s.size === "90")
  assert.ok(ninety)
  await setSlotLabel(ninety.id, "Bear 90")

  // Re-cluster. Both slots sit on the same point, so only the size tells them
  // apart — carrying forward by position alone would put the name on either.
  await setSlots(postId, [
    { point: { x: 0.5, y: 0.5 }, variantId: null, size: "90", claimIds: [small.id] },
    { point: { x: 0.5, y: 0.5 }, variantId: null, size: "95", claimIds: [large.id] },
  ])

  const after = await listSlots(postId)
  assert.equal(after.find((s) => s.size === "90")?.label, "Bear 90")
  assert.equal(after.find((s) => s.size === "95")?.label, "")
})

test("a short buy goes to the paying customer first", async () => {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: "test/e.jpg", imageWidth: 100, imageHeight: 100,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  // No payments exist for either customer in this event, so both rank unpaid and
  // the tie-break is claim id — arrival order, which is the rule we assert here.
  const early = await addClaim({
    postId, sender: "1", customer: null, source: "ink", point: { x: 0.2, y: 0.2 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  const late = await addClaim({
    postId, sender: "2", customer: null, source: "ink", point: { x: 0.2, y: 0.2 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  await setSlots(postId, [
    { point: { x: 0.2, y: 0.2 }, variantId: null, size: "", claimIds: [early.id, late.id] },
  ])
  const [slot] = await listSlots(postId)

  await setSlotBought(slot.id, 1)

  const claims = await listClaims(postId)
  assert.equal(claims.find((c) => c.id === early.id)?.obtained, 1)
  assert.equal(claims.find((c) => c.id === late.id)?.obtained, 0)
  assert.equal((await listSlots(postId))[0].bought, 1, "the slot total is the sum of its claims")
})

test("a tick on one claim buys exactly that claim", async () => {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: "test/f.jpg", imageWidth: 100, imageHeight: 100,
    store: "", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  const first = await addClaim({
    postId, sender: "1", customer: null, source: "ink", point: { x: 0.3, y: 0.3 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })
  const second = await addClaim({
    postId, sender: "2", customer: null, source: "ink", point: { x: 0.3, y: 0.3 },
    variantId: null, quantity: 2, note: "", confidence: 1, state: "pending", messageId: "",
  })
  await setSlots(postId, [
    { point: { x: 0.3, y: 0.3 }, variantId: null, size: "", claimIds: [first.id, second.id] },
  ])

  // The owner ticked the SECOND customer's message, who asked for two.
  await markClaimObtained(second.id, 2)

  const claims = await listClaims(postId)
  assert.equal(claims.find((c) => c.id === first.id)?.obtained, 0)
  assert.equal(claims.find((c) => c.id === second.id)?.obtained, 2)
  assert.equal((await listSlots(postId))[0].bought, 2)
})
```

Also update the three earlier tests in this file that call `setSlots`, adding
`size: ""` to each slot literal — `setSlots` now requires it.

- [ ] **Step 4: Run to confirm they fail**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/claims.test.ts`
Expected: FAIL — `setSlotLabel` and `markClaimObtained` are not exported, and
`WaSlot` has no `size`.

- [ ] **Step 5: Update the data layer**

In `lib/db/claims.ts`, add to the imports at the top:

```typescript
import { fetchPaidStatusMap, compareOrderPriority } from "./shopping-list"
import { allocateFifo } from "@/lib/fifo-fill"
```

Add `obtained` to `WaClaim`, after `quantity`:

```typescript
  quantity: number
  /** How many of this claim were actually bought. The slot's total is the sum. */
  obtained: number
```

and in `mapClaim`, after the `quantity` line:

```typescript
    obtained: (r.obtained as number) ?? 0,
```

Replace the `WaSlot` interface with:

```typescript
export interface WaSlot {
  id: number
  postId: number
  point: Point | null
  variantId: string | null
  /** Size this slot is for. Empty means nobody said one — a real state, not a gap. */
  size: string
  /** Working name. Not a product: naming is a separate, heavier act. */
  label: string
  /** Sum of the quantities of the claims attached to this slot. Derived. */
  claimed: number
  /** Sum of what those claims obtained. Also derived — see migration 064. */
  bought: number
  productId: number | null
}
```

Replace `setSlots` with:

```typescript
/**
 * Replace a post's slots with a freshly clustered set.
 *
 * Clustering is recomputed whenever a claim arrives, so this runs often. What
 * it must NOT do is discard the three things a slot knows that clustering
 * cannot recompute — the working name, the product it was named as, and (via
 * its claims) what was bought. The first two are matched back by position AND
 * size, because two sizes of one item sit at the same point on the photograph
 * and position alone would let their identities swap.
 *
 * What was bought needs no carrying: it lives on the claims, which are not
 * touched here beyond being re-pointed.
 */
export async function setSlots(
  postId: number,
  slots: { point: Point | null; variantId: string | null; size: string; claimIds: number[] }[],
): Promise<void> {
  await sql.begin(async (tx) => {
    const existing = await tx`SELECT * FROM wa_slots WHERE post_id = ${postId}`

    const carried = slots.map((slot) => {
      const previous = existing.find((e) => {
        if ((e.size as string) !== slot.size) return false
        if (slot.variantId !== null) return e.variant_id === slot.variantId
        if (slot.point === null || e.point_x === null) return false
        return Math.hypot(Number(e.point_x) - slot.point.x, Number(e.point_y) - slot.point.y) < 0.03
      })
      return {
        ...slot,
        label: (previous?.label as string) ?? "",
        productId: (previous?.product_id as number | null) ?? null,
      }
    })

    await tx`UPDATE wa_claims SET slot_id = NULL WHERE post_id = ${postId}`
    await tx`DELETE FROM wa_slots WHERE post_id = ${postId}`

    for (const slot of carried) {
      const [row] = await tx`
        INSERT INTO wa_slots (post_id, point_x, point_y, variant_id, size, label, product_id)
        VALUES (${postId}, ${slot.point?.x ?? null}, ${slot.point?.y ?? null},
          ${slot.variantId}, ${slot.size}, ${slot.label}, ${slot.productId})
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
```

Replace `listSlots` with:

```typescript
export async function listSlots(postId: number): Promise<WaSlot[]> {
  const rows = await sql`
    SELECT s.*,
           COALESCE(SUM(c.quantity), 0)::int AS claimed,
           COALESCE(SUM(c.obtained), 0)::int AS bought
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
      size: (r.size as string) ?? "",
      label: (r.label as string) ?? "",
      claimed: (r.claimed as number) ?? 0,
      bought: (r.bought as number) ?? 0,
      productId: (r.product_id as number | null) ?? null,
    }
  })
}
```

Replace `setSlotBought` with the three functions below:

```typescript
/** The working name, typed once in the shop. Creates nothing. */
export async function setSlotLabel(
  slotId: number,
  label: string,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE wa_slots SET label = ${label.trim()}, updated_at = NOW() WHERE id = ${slotId}
  `
}

/** One claim's outcome — what the owner's tick in the group means. */
export async function markClaimObtained(
  claimId: number,
  obtained: number,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE wa_claims SET obtained = ${Math.max(0, Math.trunc(obtained))}, updated_at = NOW()
    WHERE id = ${claimId}
  `
}

/**
 * The stepper: "I got N of this SKU", without saying whose.
 *
 * Spends N across the slot's claims in the order the rest of the app already
 * settles a shortage — paid, then partly paid, then unpaid, then whoever asked
 * first. Claims that get nothing are reset to zero, because N is a statement
 * about the whole slot rather than an increment.
 *
 * The owner's tick on a single message writes the same column directly. Both
 * roads lead to wa_claims.obtained, so the shopping list cannot show one number
 * while the orders behind it say another.
 */
export async function setSlotBought(slotId: number, bought: number): Promise<void> {
  const [slot] = await sql`
    SELECT s.id, p.event
    FROM wa_slots s JOIN wa_posts p ON p.id = s.post_id
    WHERE s.id = ${slotId}
  `
  if (!slot) throw new Error(`no such slot: ${slotId}`)

  const rows = await sql`
    SELECT id, customer, quantity FROM wa_claims
    WHERE slot_id = ${slotId} AND state <> 'rejected'
    ORDER BY id ASC
  `
  const event = slot.event as string
  const claims = rows.map((r) => ({
    id: r.id as number,
    // An unresolved sender has no payment history to rank on, so they sort as
    // unpaid — which is where an unknown belongs when units are short.
    customer: (r.customer as string | null) ?? "",
    quantity: r.quantity as number,
  }))

  const statusMap = await fetchPaidStatusMap([event])
  claims.sort(compareOrderPriority(event, statusMap))

  const { allocations } = allocateFifo(claims, (c) => c.quantity, Math.max(0, Math.trunc(bought)))
  const given = new Map(allocations.map((a) => [a.item.id, a.allocated]))

  await sql.begin(async (tx) => {
    for (const claim of claims) {
      await tx`
        UPDATE wa_claims SET obtained = ${given.get(claim.id) ?? 0}, updated_at = NOW()
        WHERE id = ${claim.id}
      `
    }
  })
}
```

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS — every existing test plus the four new claims tests.

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no output.

```bash
git add supabase/migrations/064_wa_sku_slots.sql lib/db/claims.ts lib/db/claims.test.ts
git commit -m "feat(db): SKU slots, and buying recorded against claims

A shelf item three people want in 90 and two want in 95 is two things to pick
up, two lines on the shopping list, and two products at naming. So size moves
out of the claim's free text onto the slot, and one position on a photograph can
now carry several slots. Carrying a slot's identity forward through re-clustering
therefore matches on size as well as position: two sizes sit at the same point,
and position alone let their names swap.

And bought moves from the slot onto the claim. The owner ticks a customer's
message as the item goes in the basket, which says exactly who got one — strictly
more than a count. The stepper still takes a bare number but now spends it across
the claims by payment priority, the same rule short arrivals already use. One
column, two ways in, nothing to reconcile.

The old per-slot tallies are spread onto claims before the column is dropped, so
a database that already has counts does not lose them."
```

---

### Task 3: Clustering splits a position into per-size slots

**Files:**
- Modify: `lib/whatsapp/ingest.ts`
- Modify: `lib/whatsapp/ingest.test.ts`

**Interfaces:**
- Consumes: `normalizeSize` from Task 1; `setSlots` from Task 2.
- Produces: `recluster(postId)` unchanged in signature, changed in behaviour — every cluster is now split by the size read from its claims' notes.

- [ ] **Step 1: Write the failing test**

Append to `lib/whatsapp/ingest.test.ts`, and extend its imports:

```typescript
import { createPost, addClaim, listClaims, listSlots } from "../db/claims"
import { ingestImageReply, recluster } from "./ingest"
```

```typescript
test("one position with two sizes becomes two SKU", async () => {
  const { id: postId } = await shelfPost()
  await addClaim({
    postId, sender: "1", customer: null, source: "ink", point: { x: 0.4, y: 0.4 },
    variantId: null, quantity: 1, note: "size 90", confidence: 1, state: "pending", messageId: "",
  })
  await addClaim({
    postId, sender: "2", customer: null, source: "ink", point: { x: 0.405, y: 0.4 },
    variantId: null, quantity: 2, note: "yg 95 ya kak", confidence: 1, state: "pending", messageId: "",
  })

  await recluster(postId)

  const slots = await listSlots(postId)
  assert.equal(slots.length, 2, "same spot on the shelf, two things to buy")
  assert.deepEqual(slots.map((s) => s.size).sort(), ["90", "95"])
  assert.equal(slots.find((s) => s.size === "95")?.claimed, 2)
})

test("claims that name no size share one unsized SKU", async () => {
  const { id: postId } = await shelfPost()
  await addClaim({
    postId, sender: "1", customer: null, source: "ink", point: { x: 0.7, y: 0.3 },
    variantId: null, quantity: 1, note: "mau 1", confidence: 1, state: "pending", messageId: "",
  })
  await addClaim({
    postId, sender: "2", customer: null, source: "ink", point: { x: 0.705, y: 0.302 },
    variantId: null, quantity: 1, note: "", confidence: 1, state: "pending", messageId: "",
  })

  await recluster(postId)

  const slots = await listSlots(postId)
  assert.equal(slots.length, 1)
  assert.equal(slots[0].size, "", "no size is a state, not a guess")
  assert.equal(slots[0].claimed, 2)
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/whatsapp/ingest.test.ts`
Expected: FAIL — one slot where two are expected, since `recluster` does not yet
split by size.

- [ ] **Step 3: Implement**

In `lib/whatsapp/ingest.ts`, change the import line to add `normalizeSize`:

```typescript
import { resolveImageReply, clusterPoints, normalizeSize, type Point } from "@/lib/claims"
```

Replace the body of `recluster` with:

```typescript
export async function recluster(postId: number): Promise<void> {
  const claims = await listClaims(postId)
  const live = claims.filter((c) => c.state !== "rejected")

  const positioned = live.filter((c) => c.point !== null)
  const clusters = clusterPoints(positioned.map((c) => c.point as Point))

  // A cluster is a place on the shelf. What is bought there may still be two
  // different things, so each cluster splits again by the size its claims name.
  // The centre stays the cluster's, not the sub-group's: both sizes hang on the
  // same peg, and moving one badge sideways would only make the picture lie.
  const positional = clusters.flatMap((cluster) => {
    const bySize = new Map<string, number[]>()
    for (const index of cluster.members) {
      const claim = positioned[index]
      const size = normalizeSize(claim.note)
      const list = bySize.get(size) ?? []
      list.push(claim.id)
      bySize.set(size, list)
    }
    return [...bySize.entries()].map(([size, claimIds]) => ({
      point: cluster.centre,
      variantId: null as string | null,
      size,
      claimIds,
    }))
  })

  // Variant claims have no position, so they group by variant id instead. The
  // variant already IS the size, so nothing is read out of the note here.
  const byVariant = new Map<string, number[]>()
  for (const claim of live) {
    if (claim.variantId === null) continue
    const list = byVariant.get(claim.variantId) ?? []
    list.push(claim.id)
    byVariant.set(claim.variantId, list)
  }
  const variantSlots = [...byVariant.entries()].map(([variantId, claimIds]) => ({
    point: null,
    variantId,
    size: "",
    claimIds,
  }))

  await setSlots(postId, [...positional, ...variantSlots])
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS — everything, plus the two new ingest tests.

- [ ] **Step 5: Commit**

```bash
git add lib/whatsapp/ingest.ts lib/whatsapp/ingest.test.ts
git commit -m "feat(whatsapp): split a clustered position into per-size SKU

A cluster is a place on the shelf, but what gets bought there may still be two
different things. Each cluster now splits again by the size its claims name,
while both keep the cluster's centre — the sizes hang on the same peg, and moving
one badge sideways would only make the picture lie.

Claims naming no size share one unsized SKU rather than each becoming their own.
That is the state to show the owner, who can split it by hand if the sizes turn
out to have mattered."
```

---

### Task 4: Render the shopping-list picture

**Files:**
- Create: `lib/whatsapp/render.ts`
- Create: `lib/whatsapp/render.test.ts`

**Interfaces:**
- Consumes: `getPost`, `listSlots` from `lib/db/claims`; `downloadPostImage` from `lib/storage`; `sharp`.
- Produces:
  - `renderShoppingList(postId: number): Promise<Buffer>` — a JPEG.
  - `SHOPPING_LIST_WIDTH = 900`

This is the "B+L" the owner chose: a badge on each slot showing how many are
still to buy, and a printed list underneath with a line per SKU. The badge
geometry and colours below are the ones that were mocked up and approved — do
not redesign them.

> **Fonts are the risk in this task.** `sharp` renders SVG text through librsvg,
> which needs a font present on the machine. It works on macOS; a slim Linux
> container may have none, and the failure is silent — text simply vanishes
> rather than throwing. Step 5 checks for it explicitly. If the check fails on a
> deployment target, the fix is to install `fonts-dejavu-core` in that image, not
> to change this code.

- [ ] **Step 1: Write the failing test**

Create `lib/whatsapp/render.test.ts`:

```typescript
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sharp from "sharp"
import sql from "../db-pool"
import { FIXTURES } from "../claims/fixtures"
import { createPost, addClaim, setSlots, listSlots, setSlotLabel, setSlotBought } from "../db/claims"
import { renderShoppingList, SHOPPING_LIST_WIDTH } from "./render"

const EVENT = `TESTRENDER${process.hrtime.bigint()}`

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
})

after(async () => {
  await sql`DELETE FROM wa_posts WHERE event = ${EVENT}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

/** A post with two SKU at one position and one elsewhere. */
async function populatedPost() {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: FIXTURES.original, imageWidth: 1600, imageHeight: 2133,
    store: "Nishimatsuya", countryId: null, pricingMethod: "overseas", note: "", safeHues: [130],
  })
  const ids: number[] = []
  for (const [note, point] of [
    ["size 90", { x: 0.6, y: 0.47 }],
    ["size 95", { x: 0.6, y: 0.47 }],
    ["", { x: 0.24, y: 0.79 }],
  ] as const) {
    const { id } = await addClaim({
      postId, sender: "1", customer: null, source: "ink", point,
      variantId: null, quantity: 1, note, confidence: 1, state: "pending", messageId: "",
    })
    ids.push(id)
  }
  await setSlots(postId, [
    { point: { x: 0.6, y: 0.47 }, variantId: null, size: "90", claimIds: [ids[0]] },
    { point: { x: 0.6, y: 0.47 }, variantId: null, size: "95", claimIds: [ids[1]] },
    { point: { x: 0.24, y: 0.79 }, variantId: null, size: "", claimIds: [ids[2]] },
  ])
  const slots = await listSlots(postId)
  await setSlotLabel(slots[0].id, "Brown Bear Set")
  await setSlotLabel(slots[1].id, "Brown Bear Set")
  await setSlotLabel(slots[2].id, "Bunny Dressing Set")
  await setSlotBought(slots[0].id, 1)
  return { postId, slots }
}

test("the picture is taller than the photo, because the list is under it", async () => {
  const { postId } = await populatedPost()
  const image = await renderShoppingList(postId)
  const meta = await sharp(image).metadata()

  assert.equal(meta.width, SHOPPING_LIST_WIDTH)
  // The fixture is 1600x2133, so the photo alone is 1200 tall at this width.
  assert.ok(
    (meta.height ?? 0) > 1200,
    `expected room for the list below the photo, got ${meta.height}`,
  )
  assert.equal(meta.format, "jpeg")
})

test("a post with no claims still renders, rather than failing", async () => {
  const { id: postId } = await createPost({
    event: EVENT, imagePath: FIXTURES.original, imageWidth: 1600, imageHeight: 2133,
    store: "Nishimatsuya", countryId: null, pricingMethod: "overseas", note: "", safeHues: [],
  })
  const image = await renderShoppingList(postId)
  const meta = await sharp(image).metadata()
  assert.equal(meta.width, SHOPPING_LIST_WIDTH)
})

test("an unknown post is an error, not an empty image", async () => {
  await assert.rejects(() => renderShoppingList(0), /no such post/)
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/whatsapp/render.test.ts`
Expected: FAIL — cannot resolve `./render`.

- [ ] **Step 3: Implement**

Create `lib/whatsapp/render.ts`:

```typescript
import { existsSync } from "node:fs"
import sharp from "sharp"
import { getPost, listSlots, type WaSlot } from "@/lib/db/claims"
import { downloadPostImage } from "@/lib/storage"

/** Width the picture is rendered at. Wide enough to read on a phone, small
 *  enough to send over a mobile connection in a shop. */
export const SHOPPING_LIST_WIDTH = 900

const DONE = "#16a34a"
const PARTIAL = "#f59e0b"
const OPEN = "#dc2626"

const tone = (claimed: number, bought: number) =>
  bought >= claimed ? DONE : bought > 0 ? PARTIAL : OPEN

/** SVG text is not HTML, and a customer's label can contain anything. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * Read the post's image.
 *
 * image_path holds a bucket object key in normal use, but the ingest tests store
 * a local filesystem path so the resolver can read a fixture directly. Falling
 * back to the filesystem keeps both working without a second code path through
 * the renderer.
 */
async function readPostImage(imagePath: string): Promise<Buffer> {
  if (existsSync(imagePath)) return sharp(imagePath).toBuffer()
  return downloadPostImage(imagePath)
}

/**
 * One badge per SKU: how many are STILL TO BUY, not how many were claimed.
 *
 * That is the number the owner acts on while holding a basket — "4/5" needs a
 * subtraction first. The bought-of-claimed figure stays, smaller, underneath.
 */
function badge(slot: WaSlot, cx: number, cy: number): string {
  const left = slot.claimed - slot.bought
  const colour = tone(slot.claimed, slot.bought)
  const r = 40
  return `
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${colour}" stroke="#fff" stroke-width="5"/>
    <text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="${left === 0 ? 34 : 40}"
          font-weight="700" fill="#fff">${left === 0 ? "✓" : left}</text>
    <rect x="${cx - 44}" y="${cy + r + 4}" width="88" height="26" rx="13"
          fill="#111827" fill-opacity="0.82"/>
    <text x="${cx}" y="${cy + r + 23}" text-anchor="middle" font-size="18" font-weight="600"
          fill="#fff">${slot.bought} of ${slot.claimed}</text>`
}

const ROW_HEIGHT = 40
const LIST_HEADER = 44
const LIST_PADDING = 16

/** One line per SKU, under the photo. Sizes are their own lines, indented. */
function listRow(slot: WaSlot, index: number, width: number, top: number, indent: boolean): string {
  const left = slot.claimed - slot.bought
  const colour = tone(slot.claimed, slot.bought)
  const name = escapeXml(slot.label || `SKU ${index + 1}`)
  const action = left === 0 ? "done" : `buy ${left}`

  const marker = indent
    ? `<rect x="60" y="${top + 6}" width="4" height="18" rx="2" fill="${colour}"/>`
    : `<circle cx="34" cy="${top + 13}" r="13" fill="${colour}"/>`
  const title = indent
    ? `<text x="76" y="${top + 21}" font-size="22" fill="#4b5563">${name} · size ${escapeXml(slot.size)}</text>`
    : `<text x="60" y="${top + 21}" font-size="24" font-weight="600" fill="#111827">${name}${slot.size ? ` · ${escapeXml(slot.size)}` : ""}</text>`

  return `
    ${marker}
    ${title}
    <text x="${width - 150}" y="${top + 21}" text-anchor="end" font-size="22"
          fill="#9ca3af">${slot.bought}/${slot.claimed}</text>
    <text x="${width - 24}" y="${top + 21}" text-anchor="end" font-size="23" font-weight="700"
          fill="${colour}">${action}</text>`
}

/**
 * The picture the owner shops from, and the one /rekap posts.
 *
 * Badges say what to grab; the list under the photo carries the detail badges
 * have no room for — which SKU, which size, and the name once one has been
 * typed. Two SKU at one position share a badge position by design: they hang on
 * the same peg, so their two lines in the list are what tells them apart.
 */
export async function renderShoppingList(postId: number): Promise<Buffer> {
  const post = await getPost(postId)
  if (post === null) throw new Error(`no such post: ${postId}`)

  const slots = await listSlots(postId)
  const photo = sharp(await readPostImage(post.imagePath)).resize({ width: SHOPPING_LIST_WIDTH })
  const base = await photo.toBuffer()
  const { width = SHOPPING_LIST_WIDTH, height = 0 } = await sharp(base).metadata()

  // Slots sharing a position share a badge, so it is drawn once for the group.
  const drawn = new Set<string>()
  const badges = slots
    .filter((s) => s.point !== null)
    .map((slot) => {
      const point = slot.point as { x: number; y: number }
      const key = `${point.x.toFixed(3)}|${point.y.toFixed(3)}`
      if (drawn.has(key)) return ""
      drawn.add(key)
      const together = slots.filter(
        (s) => s.point !== null && `${s.point.x.toFixed(3)}|${s.point.y.toFixed(3)}` === key,
      )
      const merged: WaSlot = {
        ...slot,
        claimed: together.reduce((n, s) => n + s.claimed, 0),
        bought: together.reduce((n, s) => n + s.bought, 0),
      }
      return badge(merged, point.x * width, point.y * height)
    })
    .join("")

  // A split item gets a heading line plus one line per size; everything else
  // gets a single line.
  const byLabel = new Map<string, WaSlot[]>()
  for (const slot of slots) {
    const key = slot.label || `#${slot.id}`
    byLabel.set(key, [...(byLabel.get(key) ?? []), slot])
  }
  const lines: { slot: WaSlot; indent: boolean }[] = []
  for (const group of byLabel.values()) {
    if (group.length === 1) {
      lines.push({ slot: group[0], indent: false })
    } else {
      const total: WaSlot = {
        ...group[0],
        size: "",
        claimed: group.reduce((n, s) => n + s.claimed, 0),
        bought: group.reduce((n, s) => n + s.bought, 0),
      }
      lines.push({ slot: total, indent: false })
      for (const slot of group) lines.push({ slot, indent: true })
    }
  }

  const listHeight = LIST_HEADER + lines.length * ROW_HEIGHT + LIST_PADDING
  let y = height + LIST_HEADER
  const rows = lines
    .map(({ slot, indent }, i) => {
      const row = listRow(slot, i, width, y, indent)
      y += ROW_HEIGHT
      return row
    })
    .join("")

  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + listHeight}">
      <style>text { font-family: Helvetica, Arial, "DejaVu Sans", sans-serif; }</style>
      ${badges}
      <rect x="0" y="${height}" width="${width}" height="${listHeight}" fill="#ffffff"/>
      <text x="24" y="${height + 30}" font-size="20" font-weight="700" fill="#6b7280"
            letter-spacing="1.5">WHAT TO BUY · ${slots.length} SKU</text>
      ${rows}
    </svg>`,
  )

  return sharp(base)
    .extend({ bottom: listHeight, background: "#ffffff" })
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 82 })
    .toBuffer()
}
```

Note `index` is incremented but the fallback label uses the row index — that is
intentional: `SKU 1` numbering follows the printed order, which is what someone
reading the picture counts.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS — everything, plus the three render tests.

- [ ] **Step 5: Look at the output, and check the text actually drew**

Fonts fail silently under librsvg, so this step is not optional.

Create a throwaway script at the repo root (it is deleted in the next step —
scripts outside the repo are compiled as CJS by `tsx` and cannot use top-level
await):

```typescript
// _check.ts
import { writeFileSync } from "node:fs"
import sql from "./lib/db-pool"
import { renderShoppingList } from "./lib/whatsapp/render"

async function main() {
  const [row] = await sql`SELECT id FROM wa_posts ORDER BY id DESC LIMIT 1`
  if (!row) throw new Error("no posts in the database — run the render tests first")
  writeFileSync("/tmp/rekap.jpg", await renderShoppingList(row.id))
  console.log("wrote /tmp/rekap.jpg for post", row.id)
  await sql.end()
}
main()
```

Run:

```bash
npx tsx --env-file-if-exists=.env.development.local _check.ts
open /tmp/rekap.jpg
```

Expected: badges over the shelf photo, and a white list under it whose rows show
**readable words and digits**. If the list area is blank white with coloured dots
but no text, librsvg found no font — install one on this machine before
continuing, since every later task renders this picture.

- [ ] **Step 6: Commit**

```bash
rm -f _check.ts
git add lib/whatsapp/render.ts lib/whatsapp/render.test.ts
git commit -m "feat(whatsapp): render the shopping-list picture

Badges say what to grab — how many are STILL to buy, not how many were claimed,
because a number you act on beats a fraction you have to subtract first while
holding a basket. The bought-of-claimed figure stays underneath, smaller.

The list under the photo carries what a badge has no room for: which SKU, which
size, and the working name once one has been typed. Two sizes of one item share
a badge on purpose — they hang on the same peg, and their two lines in the list
are what tells them apart. Moving one badge sideways would only make the picture
lie about where the thing is.

Post images are read from the bucket, falling back to the filesystem so the
fixture-backed tests keep working without a second path through the renderer."
```

---

### Task 5: Migration 065 — groups, bot admins, and the capture window

**Files:**
- Create: `supabase/migrations/065_wa_groups.sql`
- Create: `lib/db/whatsapp-groups.ts`
- Create: `lib/db/whatsapp-groups.test.ts`

**Interfaces:**
- Produces:
  - `listGroups(): Promise<WaGroup[]>`, `upsertGroup(input)`, `bindGroupToEvent(jid, event)`
  - `listBotAdmins(): Promise<BotAdmin[]>`, `addBotAdmin(input)`, `removeBotAdmin(number)`, `isBotAdmin(number)`, `canConnect(number)`
  - `openCapture(jid, store)`, `closeCapture(jid)`, `currentCapture(jid): Promise<Capture | null>`

The worker in plan 3 writes these tables; plan 2c gives them a settings screen.
They are built here because both of those need somewhere to read from, and
because the capture window is what decides whether an image the owner posts is a
product post or ordinary chat.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/065_wa_groups.sql`:

```sql
-- Which groups the bot is in, who may command it, and when it is collecting.

CREATE TABLE IF NOT EXISTS wa_groups (
  -- The WhatsApp group JID (…@g.us). Stable; the group's NAME is not, which is
  -- why the name below is only a cache.
  jid           TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  -- Which trip this group's claims belong to. Null until someone connects it.
  -- Groups outlive events and are re-bound rather than recreated.
  event         TEXT REFERENCES events(name) ON UPDATE CASCADE ON DELETE SET NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  name_checked_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ
);

-- Numbers allowed to command the bot.
--
-- The app's own roles key on email (lib/roles.ts), and a WhatsApp sender has a
-- number and no login, so this cannot reuse that check. It mirrors the same two
-- tiers: anyone here may pull the shopping list, and can_connect marks the one
-- person who may bind a group to an event, because that decides where every
-- claim for a trip lands.
CREATE TABLE IF NOT EXISTS wa_admins (
  -- Digits only, country code included, no plus. Normalize before writing.
  number        TEXT PRIMARY KEY,
  label         TEXT NOT NULL DEFAULT '',
  can_connect   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A capture window: while one is open, images the owner posts to that group
-- become posts, and outside it they are ordinary chat.
--
-- This exists so nothing has to be typed per photo. The window also carries the
-- store, which is the one field a post cannot derive from the event or the
-- settings — so it is stated once per shop rather than once per item.
CREATE TABLE IF NOT EXISTS wa_captures (
  id            SERIAL PRIMARY KEY,
  group_jid     TEXT NOT NULL REFERENCES wa_groups(jid) ON DELETE CASCADE,
  store         TEXT NOT NULL DEFAULT '',
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Null while open. Closed by command, or by the worker after a quiet spell, so
  -- that forgetting the command does not turn tomorrow's chat into posts.
  closed_at     TIMESTAMPTZ
);

-- At most one window open per group. A partial unique index says exactly that,
-- where a plain one would forbid a group ever having two closed windows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_captures_open
  ON wa_captures (group_jid) WHERE closed_at IS NULL;
```

- [ ] **Step 2: Apply and verify**

```bash
PSQL=psql; [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
"$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/065_wa_groups.sql
"$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\dt wa_*"
```

Expected: `wa_admins`, `wa_captures`, `wa_claims`, `wa_groups`, `wa_posts`, `wa_slots`.

- [ ] **Step 3: Write the failing tests**

Create `lib/db/whatsapp-groups.test.ts`:

```typescript
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../db-pool"
import {
  upsertGroup, bindGroupToEvent, listGroups,
  addBotAdmin, removeBotAdmin, isBotAdmin, canConnect,
  openCapture, closeCapture, currentCapture,
} from "./whatsapp-groups"

const EVENT = `TESTGRP${process.hrtime.bigint()}`
const JID = `${process.hrtime.bigint()}@g.us`
const NUMBER = `62811${process.hrtime.bigint()}`.slice(0, 15)

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
})

after(async () => {
  await sql`DELETE FROM wa_groups WHERE jid = ${JID}`
  await sql`DELETE FROM wa_admins WHERE number = ${NUMBER}`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

test("a group is bound to an event, not recreated per trip", async () => {
  await upsertGroup({ jid: JID, name: "Jastip Agustus" })
  await bindGroupToEvent(JID, EVENT)

  const group = (await listGroups()).find((g) => g.jid === JID)
  assert.ok(group)
  assert.equal(group.event, EVENT)
  assert.equal(group.name, "Jastip Agustus")

  // Re-upserting refreshes the cached name without unbinding the event.
  await upsertGroup({ jid: JID, name: "Jastip Agustus (2)" })
  const again = (await listGroups()).find((g) => g.jid === JID)
  assert.equal(again?.name, "Jastip Agustus (2)")
  assert.equal(again?.event, EVENT, "renaming a group must not detach its event")
})

test("only a can_connect number may bind a group", async () => {
  await addBotAdmin({ number: NUMBER, label: "helper", canConnect: false })
  assert.equal(await isBotAdmin(NUMBER), true)
  assert.equal(await canConnect(NUMBER), false)

  await addBotAdmin({ number: NUMBER, label: "helper", canConnect: true })
  assert.equal(await canConnect(NUMBER), true, "re-adding updates rather than duplicating")
})

test("an unknown number is neither admin nor connector", async () => {
  assert.equal(await isBotAdmin("6280000000000"), false)
  assert.equal(await canConnect("6280000000000"), false)
})

test("a group has at most one open capture window", async () => {
  await upsertGroup({ jid: JID, name: "Jastip Agustus" })
  await closeCapture(JID)

  await openCapture(JID, "Nishimatsuya")
  const open = await currentCapture(JID)
  assert.ok(open)
  assert.equal(open.store, "Nishimatsuya")

  // Opening again while one is open re-points the store rather than failing:
  // the owner walked into the next shop and said so.
  await openCapture(JID, "Akachan Honpo")
  const moved = await currentCapture(JID)
  assert.equal(moved?.store, "Akachan Honpo")
  assert.equal(moved?.id, open.id, "same window, new shop")

  await closeCapture(JID)
  assert.equal(await currentCapture(JID), null)
})

test("removing an admin takes the permission with it", async () => {
  await addBotAdmin({ number: NUMBER, label: "helper", canConnect: true })
  await removeBotAdmin(NUMBER)
  assert.equal(await isBotAdmin(NUMBER), false)
})
```

- [ ] **Step 4: Run to confirm it fails**

Run: `npx tsx --env-file-if-exists=.env.development.local --test lib/db/whatsapp-groups.test.ts`
Expected: FAIL — cannot resolve `./whatsapp-groups`.

- [ ] **Step 5: Implement**

Create `lib/db/whatsapp-groups.ts`:

```typescript
import sql from "../db-pool"
import type { DBExecutor } from "./actor"
import { tsToString } from "./helpers"

export interface WaGroup {
  jid: string
  name: string
  event: string | null
  active: boolean
  createdAt: string
}

export interface BotAdmin {
  number: string
  label: string
  canConnect: boolean
}

export interface Capture {
  id: number
  groupJid: string
  store: string
  openedAt: string
}

/**
 * Strip a WhatsApp number down to digits.
 *
 * Numbers arrive as JIDs, with plus signs, with leading zeros, and typed by hand
 * into a settings form. Comparing any two of those spellings directly fails, and
 * a failed comparison here means a command silently ignored.
 */
export function normalizeNumber(value: string): string {
  const digits = value.replace(/\D/g, "")
  // Indonesian numbers are written 08xx locally and 628xx internationally.
  return digits.startsWith("0") ? `62${digits.slice(1)}` : digits
}

/** Record a group, or refresh its cached name. Never touches its event. */
export async function upsertGroup(
  input: { jid: string; name: string },
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    INSERT INTO wa_groups (jid, name, name_checked_at)
    VALUES (${input.jid}, ${input.name}, NOW())
    ON CONFLICT (jid) DO UPDATE SET
      name = EXCLUDED.name,
      name_checked_at = NOW(),
      updated_at = NOW()
  `
}

/** Bind a group to the trip whose claims it collects. */
export async function bindGroupToEvent(
  jid: string,
  event: string | null,
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    UPDATE wa_groups SET event = ${event}, updated_at = NOW() WHERE jid = ${jid}
  `
}

export async function listGroups(): Promise<WaGroup[]> {
  const rows = await sql`SELECT * FROM wa_groups ORDER BY name ASC, jid ASC`
  return rows.map((r) => ({
    jid: r.jid as string,
    name: (r.name as string) ?? "",
    event: (r.event as string | null) ?? null,
    active: (r.active as boolean) ?? true,
    createdAt: tsToString(r.created_at as Date | null),
  }))
}

export async function addBotAdmin(
  input: { number: string; label: string; canConnect: boolean },
  db: DBExecutor = sql,
): Promise<void> {
  await db`
    INSERT INTO wa_admins (number, label, can_connect)
    VALUES (${normalizeNumber(input.number)}, ${input.label}, ${input.canConnect})
    ON CONFLICT (number) DO UPDATE SET
      label = EXCLUDED.label,
      can_connect = EXCLUDED.can_connect
  `
}

export async function removeBotAdmin(number: string, db: DBExecutor = sql): Promise<void> {
  await db`DELETE FROM wa_admins WHERE number = ${normalizeNumber(number)}`
}

export async function listBotAdmins(): Promise<BotAdmin[]> {
  const rows = await sql`SELECT * FROM wa_admins ORDER BY number ASC`
  return rows.map((r) => ({
    number: r.number as string,
    label: (r.label as string) ?? "",
    canConnect: (r.can_connect as boolean) ?? false,
  }))
}

export async function isBotAdmin(number: string): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM wa_admins WHERE number = ${normalizeNumber(number)}`
  return Boolean(row)
}

export async function canConnect(number: string): Promise<boolean> {
  const [row] = await sql`
    SELECT 1 FROM wa_admins WHERE number = ${normalizeNumber(number)} AND can_connect
  `
  return Boolean(row)
}

/**
 * Start collecting, or move the open window to a new shop.
 *
 * Re-opening while a window is open is not an error: it is the owner walking
 * into the next store and saying so. Treating it as one would leave photos from
 * the second shop filed under the first.
 */
export async function openCapture(
  jid: string,
  store: string,
  db: DBExecutor = sql,
): Promise<void> {
  const [open] = await db`
    SELECT id FROM wa_captures WHERE group_jid = ${jid} AND closed_at IS NULL
  `
  if (open) {
    await db`UPDATE wa_captures SET store = ${store.trim()} WHERE id = ${open.id}`
    return
  }
  await db`
    INSERT INTO wa_captures (group_jid, store) VALUES (${jid}, ${store.trim()})
  `
}

export async function closeCapture(jid: string, db: DBExecutor = sql): Promise<void> {
  await db`
    UPDATE wa_captures SET closed_at = NOW()
    WHERE group_jid = ${jid} AND closed_at IS NULL
  `
}

/** The open window for a group, or null when it is not collecting. */
export async function currentCapture(jid: string): Promise<Capture | null> {
  const [row] = await sql`
    SELECT * FROM wa_captures WHERE group_jid = ${jid} AND closed_at IS NULL
  `
  if (!row) return null
  return {
    id: row.id as number,
    groupJid: row.group_jid as string,
    store: (row.store as string) ?? "",
    openedAt: tsToString(row.opened_at as Date | null),
  }
}
```

- [ ] **Step 6: Run the tests and commit**

Run: `npm test`
Expected: PASS — everything, plus five group tests.

```bash
git add supabase/migrations/065_wa_groups.sql lib/db/whatsapp-groups.ts lib/db/whatsapp-groups.test.ts
git commit -m "feat(db): groups, bot admins and the capture window

Groups outlive trips, so a group is bound to an event and re-bound rather than
recreated, and refreshing its cached name never detaches it.

The bot cannot reuse the app's roles: those key on email and a WhatsApp sender
has a number and no login. So wa_admins mirrors the same two tiers — anyone
listed may pull the shopping list, and can_connect marks the one person who may
bind a group to an event, because that decides where a whole trip's claims land.

A capture window is what makes posting free of ceremony: while one is open the
owner's photos become posts, and outside it they are ordinary chat. It carries
the store, the one field a post cannot derive from the event or from settings,
so that is said once per shop instead of once per item. Re-opening while open
moves the shop rather than failing — that is the owner walking next door."
```

---

### Task 6: The routes plan 2c will call

**Files:**
- Create: `app/api/whatsapp/posts/route.ts`
- Create: `app/api/whatsapp/posts/[id]/route.ts`
- Create: `app/api/whatsapp/posts/[id]/rekap/route.ts`
- Create: `app/api/whatsapp/slots/[id]/route.ts`
- Modify: `lib/access.ts`

**Interfaces:**
- Consumes: `requireSession`, `requireOwner` from `lib/api`; the data layer from Tasks 2 and 5; `renderShoppingList` from Task 4.
- Produces:
  - `GET /api/whatsapp/posts?event=&search=&page=&pageSize=`
  - `GET /api/whatsapp/posts/{id}` → `{ post, slots, claims }`
  - `GET /api/whatsapp/posts/{id}/rekap` → `image/jpeg`
  - `PATCH /api/whatsapp/slots/{id}` → `{ label?, bought? }`

Next.js 16 passes route params as a Promise — `{ params }: { params: Promise<{ id: string }> }`
— which differs from earlier majors. Check
`node_modules/next/dist/docs/` before changing this shape.

- [ ] **Step 1: Open the shop screen to admins**

In `lib/access.ts`, add to `ADMIN_ROUTES`, keeping the existing comment style:

```typescript
  "/dashboard/excess-purchase", // Inventory (ready stock)
  "/dashboard/shop", // In-store tally: counting is not naming, so an admin may do it
```

`/dashboard/wa-posts` is deliberately NOT listed: naming a slot creates products
and orders, which is owner work.

- [ ] **Step 2: The list route**

Create `app/api/whatsapp/posts/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireOwner } from "@/lib/api"
import { listPosts } from "@/lib/db/claims"

export async function GET(req: NextRequest) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const ownerError = requireOwner(session)
  if (ownerError) return ownerError

  const params = req.nextUrl.searchParams
  try {
    const result = await listPosts({
      event: params.get("event") ?? undefined,
      search: params.get("search") ?? undefined,
      page: Number(params.get("page")) || 1,
      pageSize: Number(params.get("pageSize")) || 25,
    })
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to list WhatsApp posts:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}
```

- [ ] **Step 3: The single-post route**

Create `app/api/whatsapp/posts/[id]/route.ts`:

```typescript
import { NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { getPost, listSlots, listClaims } from "@/lib/db/claims"

/**
 * Everything one post knows.
 *
 * Open to any role: the shop screen reads this, and counting what is on a shelf
 * is not the same act as naming it. The write routes are where the two roles
 * part company.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const id = Number((await params).id)
  try {
    const post = await getPost(id)
    if (post === null) return NextResponse.json({ error: "Not found" }, { status: 404 })

    const [slots, claims] = await Promise.all([listSlots(id), listClaims(id)])
    return NextResponse.json({ post, slots, claims }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    console.error("Failed to load WhatsApp post:", err)
    return NextResponse.json({ error: "Failed to load" }, { status: 500 })
  }
}
```

- [ ] **Step 4: The picture route**

Create `app/api/whatsapp/posts/[id]/rekap/route.ts`:

```typescript
import { NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { renderShoppingList } from "@/lib/whatsapp/render"

/**
 * The shopping list as an image.
 *
 * Rendered per request rather than cached: claims arrive over hours, and a
 * stale picture of what to buy is worse than a slow one. It takes well under a
 * second for a shelf photograph.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const id = Number((await params).id)
  try {
    const image = await renderShoppingList(id)
    return new NextResponse(new Uint8Array(image), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
    })
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("no such post")) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    console.error("Failed to render the shopping list:", err)
    return NextResponse.json({ error: "Failed to render" }, { status: 500 })
  }
}
```

- [ ] **Step 5: The slot write route**

Create `app/api/whatsapp/slots/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server"
import { requireSession, requireRole } from "@/lib/api"
import { setSlotLabel, setSlotBought } from "@/lib/db/claims"

/**
 * The two things the shop screen writes: a working name, and how many were got.
 *
 * Open to any role on purpose. Neither creates a product, an order or a price —
 * naming does all three, and that route lives with the owner-only review page in
 * plan 2c.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, error: authError } = await requireSession()
  if (authError) return authError
  const roleError = requireRole(session)
  if (roleError) return roleError

  const id = Number((await params).id)
  try {
    const body = await req.json()

    if (typeof body.label === "string") await setSlotLabel(id, body.label)

    // Explicitly not `if (body.bought)`: zero is a real answer — "I looked and
    // there were none" — and truthiness would drop it.
    if (body.bought != null) {
      const bought = Number(body.bought)
      if (!Number.isFinite(bought) || bought < 0) {
        return NextResponse.json({ error: "bought must be zero or more" }, { status: 400 })
      }
      await setSlotBought(id, bought)
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("no such slot")) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    console.error("Failed to update slot:", err)
    return NextResponse.json({ error: "Failed to update" }, { status: 500 })
  }
}
```

- [ ] **Step 6: Typecheck, build, and look at the picture in a browser**

```bash
npx tsc --noEmit
npm run build
```

Expected: both clean.

Then start the dev server and open the rekap URL for the newest post:

```bash
PSQL=psql; [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
"$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "SELECT id, store FROM wa_posts ORDER BY id DESC LIMIT 3;"
npm run dev
```

Open `http://localhost:3000/api/whatsapp/posts/<id>/rekap` while signed in.

Expected: the annotated shopping list renders in the browser — badges over the
shelf, list underneath. This is the deliverable; if it looks wrong, fix it here
rather than in plan 2c.

- [ ] **Step 7: Commit**

```bash
git add app/api/whatsapp lib/access.ts
git commit -m "feat(api): read posts, write slots, render the shopping list

Reading a post and writing a slot are open to admins; listing posts and, later,
naming are not. The line is what an action creates: counting what is on a shelf
and calling it \"Brown Bear Set\" create nothing, while naming creates a product,
its price and every order behind it.

The picture is rendered per request rather than cached. Claims arrive over hours,
so a stale answer to \"what do I still need to buy\" is worse than a slow one, and
a shelf photograph renders in well under a second."
```

---

## What is deliberately not here

- **The two dashboard pages.** Plan 2c, consuming exactly the routes above.
- **The settings screen** for groups and bot admins. Plan 2c; the tables and the
  data layer exist so it has something to edit.
- **Naming from a slot.** `nameSlot` already works per slot, and a slot is now
  one SKU, so the gap plan 2a left — a two-size slot becoming one product — is
  closed by Task 2 rather than by new code. Plan 2c adds the route and the form.
- **Recording the purchase against orders.** Once a slot is named its orders
  exist, and `app/api/sheets/purchasing/route.ts` already distributes a bought
  quantity across them by paid priority. Plan 2c wires the slot's tally to it.
- **Anything WhatsApp.** No Baileys, no `/mulai`, no `/rekap`, no reactions —
  plan 3. The capture window and the admin list are tables here, and the worker
  fills them there.

## Open question for plan 2c

The renderer draws one badge where two SKU share a position, summing them. That
is right for a shelf where both sizes hang on one peg, and wrong for a shelf
where the owner meant two different pegs and the cluster radius merged them.
Plan 2c should let the owner drag a slot's position apart in the review page,
which fixes both that and the merged-neighbour case the spec already anticipates.
