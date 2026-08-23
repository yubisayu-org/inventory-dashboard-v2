# Receipts Restructure: Purchase Batches

## Context

Purchasing receipts are stored as a single mutable text column, `orders.receipt`, appended on every buy (`old ? old + ", " + new : new`, lib/db/shopping-list.ts:418-420; historic data also contains ";" separators). An order line bought across several shopping trips accumulates `"R123; R456, R789"` — unparseable, no quantity attribution, and the same receipt string is copy-appended onto every order the trip covered. You cannot answer "what did receipt R123 cover" or "which receipts filled this order, how many units each" without string surgery.

User-approved direction (decided during the fulfillment-gaps planning session): receipts become first-class **purchase batch** records, linked to orders with quantities. This is a standalone follow-up plan — deliberately **after** `docs/plans/fulfillment-gaps-plan.md` (its optional owner-cell receipt param is one of the write paths reworked here) and independent of `docs/plans/inventory-ledger-rework.md` (except one touchpoint noted below).

## Schema — new migration (next free number at implementation time; applied manually in Supabase SQL editor as postgres)

```sql
CREATE TABLE purchases (
  id           SERIAL PRIMARY KEY,
  receipt_no   TEXT NOT NULL,                 -- the receipt identifier/text as entered
  note         TEXT NOT NULL DEFAULT '',
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_purchases_receipt ON purchases (receipt_no);

CREATE TABLE purchase_allocations (
  id          SERIAL PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  qty         INTEGER CHECK (qty IS NULL OR qty > 0),   -- NULL = unattributed (historic rows)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_purch_alloc_order ON purchase_allocations (order_id);
CREATE INDEX idx_purch_alloc_purchase ON purchase_allocations (purchase_id);
```

- Add both tables to the audit trigger allowlist (029 pattern).
- Default privileges (019) grant app_runtime DML automatically; no extra GRANT needed. These are not append-only (a mistyped receipt_no should be editable), so no REVOKE.
- One purchase row per buy action, not deduped by text — two trips can legitimately share a receipt number; the row is the event, the text is a label.

### Data migration (same script)

1. Split every non-empty `orders.receipt` on `/[;,]/`, trim, drop empties.
2. Group identical trimmed strings **globally** into one `purchases` row each (`purchased_at` = earliest `created_at` of the orders carrying it — best effort), then one `purchase_allocations` row per (purchase, order) with `qty NULL` (historic quantities unknowable).
3. Self-check DO block: every order with non-empty receipt has ≥ 1 allocation, else RAISE EXCEPTION.
4. `ALTER TABLE orders DROP COLUMN receipt;` — readers switch to the join (below). Audit history of the old strings survives in audit_log.
5. Update `supabase/schema.sql` mirror.

## Write-path changes (complete list of current receipt writers)

1. **`markProductBought`** (lib/db/shopping-list.ts:387-436) — the buy flow: instead of appending text per order, INSERT one `purchases` row (receipt_no from the modal input) + one allocation per filled order with the allocated qty (the FIFO result already has per-order quantities). Receipt input becomes optional-but-encouraged; empty input → still create the purchase row with empty receipt_no? No — skip purchase creation when blank (nothing to record).
2. **Bulk buy** (app/api/sheets/purchasing/route.ts + `bulkUpdatePurchase` receipt-chaining in lib/db/orders.ts:500) — same: one purchase per submitted receipt, allocations per order with qty; delete the string-chaining logic from `bulkUpdatePurchase`.
3. **Excess/Inventory apply** (app/api/sheets/excess-purchase/* today; `applyInventoryToOrders` after the ledger rework) — the apply-receipt note becomes a purchase row (note: "applied from Inventory") with allocations per filled order. **Touchpoint with inventory-ledger plan:** if that lands first, wire its `applyInventoryToOrders` receipt param here; coordinate whichever ships second.
4. **`updateFormRowStage2`** (lib/db/orders.ts:318, stage "2" — no UI caller) — delete the receipt half; or delete the stage entirely if still caller-less at implementation time.
5. **`updateOrderReceipt`** (orders.ts:389, stage "receipt_cell") — used by Form Records' inline receipt cell (app/dashboard/form-records/FormRecordsTable.tsx InlineReceipt). Replace with add/remove of allocation links (see UI) or drop inline editing there in favor of the List Order receipts UI.
6. **Owner-cell optional receipt** (added by fulfillment-gaps plan Part B) — the raw Buy-raise receipt prompt creates a purchase row (note: "manual correction") + allocation with the delta qty.

## Read-path / UI changes

- **`FormRow` mapping** (lib/db/orders.ts mapFormRow + list queries): `receipt` string field replaced by `receipts: { purchaseId, receiptNo, qty }[]` via LEFT JOIN lateral JSON aggregation. Same for Form Records queries.
- **List Order (DataTable.tsx)** + **Form Records (FormRecordsTable.tsx)**: receipt column renders chips (receiptNo × qty); owner can detach a chip (DELETE allocation) or attach an existing/new receipt via a small picker (search `purchases` by receipt_no, or create new). This replaces free-text inline editing.
- **Shopping list PurchaseModal / arrival flows**: receipt input unchanged visually; submit path now records the batch.
- **New (optional, cheap): receipt detail popover** — click a chip anywhere → what that purchase covered (orders + qtys). One GET route `app/api/sheets/purchases/[id]`.

## Sequencing

1. Land after fulfillment-gaps plan (its receipt prompt is a writer here).
2. Migration + schema mirror first (inert), then one atomic code change: types → db functions → routes → UI (dropping `orders.receipt` from `FormRow` forces completeness via typecheck).
3. Migrate-then-deploy in one sitting (old code writes to a dropped column otherwise — same operational pattern as the ledger rework).

## Verification

- `npx tsc --noEmit -p .` + `npm run build`.
- Ad-hoc rollback test (npx tsx, project dir): buy a product across 2 orders in one transaction → assert 1 purchases row + 2 allocations with correct qtys; second buy same order different receipt → order shows 2 chips; ROLLBACK.
- Migration self-check built in (every receipted order keeps ≥1 allocation).
- Manual: historic order with `"R1; R2"` shows two chips (no qty); new buy shows chip with qty; Form Records receipt column still filterable/readable; detach/attach works owner-only; receipt popover lists covered orders.

## Risks

- **Historic split ambiguity**: receipts containing literal commas/semicolons in their text will over-split. Pre-flight query listing distinct receipt strings with separators lets the user eyeball before running; worst case some historic chips are fragments — data was already informal.
- **qty NULL on historic rows**: reports that sum allocation qty must COALESCE/exclude them; only affects pre-migration purchases.
- **Two parked plans touch the same functions** (`bulkUpdatePurchase`, apply routes): implement this after both or rebase the overlap consciously.
