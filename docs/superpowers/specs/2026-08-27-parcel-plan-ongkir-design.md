# Parcel Plan Ongkir — Design

**Date:** 2026-08-27
**Branch:** `feat/parcel-plan-ongkir`
**Status:** approved in brainstorming, not yet planned

## Goal

The invoice bills ongkir once per trip, on that trip's full weight, rounded up.
The parcels that actually leave are rarely those. Send half an order early and
two parcels are paid for; put two trips in one box and one is. Neither shows up
on anyone's invoice today.

Both directions are already priced correctly by `parcelPlanExtra`. Everything
this spec adds is the plumbing that lets the answer reach the invoice.

## What production says

Read on 27 Aug 2026:

| | count |
|---|---:|
| Customer-set splits (`mode = 'split'`) | 0 |
| Customer-set merges (`merge_key`) | 0 |
| System-written split fees | 0 |
| **Hand-typed merge discounts** | **9** |

The customer-facing shipping preferences have never been used, in either
direction, by anyone. The real work is the shop merging parcels itself and
typing a discount named after the other trip:

```
Gabung ongkir dengan LSCN202606    −14.000
Gabung ongkir dengan LSFT202607    −20.000
Gabung ongkir dengan LSOY202606    −31.000
Gabung ongkir dengan LSRS202651          0
```

That reorders the work. Staff recording a merge is the main case, not an
afterthought, and the naming above is the naming to keep — it says *which* trip
the parcel merged with, which a bare "Diskon ongkir" would not.

Staff also already split parcels: any card with units to ship can be shipped,
so sending what has arrived and letting the rest follow is an everyday action
that bills nothing. It is not a missing permission — `/dashboard/ship` and the
split-charge route both already admit staff.

## Model

### The adjustment is derived, not an event

One system-owned adjustment per customer, kept equal to what the current plan
costs. Every trigger recomputes it and makes the row match: insert, update, or
delete.

This is the rule that makes the awkward questions disappear. Un-merging is not
an undo path; it is a recompute that reaches a different number. The same is
true of abandoning a split, of more units arriving, and of a customer changing
her mind twice. There is no history to unwind because the row was never a record
of what anyone pressed — it is a statement of what the plan costs now.

The refunds detector already works this way, and the pattern is proven here.

### When it runs

The reconciler is cheap and idempotent, so it runs on every event that can
change what the parcels will be:

| trigger | why the plan moved |
|---|---|
| staff declare or clear **Kirim duluan** | a second parcel now exists, or no longer does |
| staff create or clear a **merge** | two parcels became one, or one became two |
| the customer changes her own preference | same, from the other side |
| units arrive (`markProductArrived`, and the marks that reduce an order) | what travels now versus later has changed |
| a charged weight is recorded on the Shipments page | reality disagreed with the estimate |

It is scoped to one customer and the trips in their plan, never the whole
event: a reconcile triggered by one customer's arrival must not rewrite
another's adjustment.

Nothing runs it on a schedule. Every path that can change a plan calls it, and
a plan cannot change any other way.

### What is owed, and to whom

```
extra = ongkirPerKg × (kilos the parcels will be billed at
                       − kilos the invoice already charged)
```

Each parcel is rounded up on its own, the way a courier charges. Positive means
charge, negative means credit, zero means the rounding absorbed it and nothing
is owed either way — which is common and must stay silent.

Worked, at Rp 25.000/kg:

| plan | invoiced | parcels | result |
|---|---|---|---|
| 1 kg split in half | 1 kg | 0.5 + 0.5 → 2 kg | charge 25.000 |
| 5 kg split 2 + 3 | 5 kg | 2 + 3 → 5 kg | nothing |
| 2.2 kg split 1.1 + 1.1 | 3 kg | 1.1 + 1.1 → 4 kg | charge 25.000 |
| two trips, 0.6 + 0.7 kg, merged | 2 kg | 1.3 → 2 kg | nothing |
| two trips, 0.4 + 0.4 kg, merged | 2 kg | 0.8 → 1 kg | credit 25.000 |

No new arithmetic is required. `parcelPlanExtra` produces every line above
today.

### She pays before the box goes

An extra fee raises what is outstanding, and shipping is already gated on
payment. So the gate does this work with no new logic: the fee appears, the
card locks, she settles, the parcel leaves. This is the order the owner asked
for and the reason the fee cannot wait until shipping to be written.

A credit lowers what is outstanding, so she pays the right amount once instead
of overpaying and waiting for a refund.

### Only a declared plan costs anything

A partly-arrived card is not a split. It is a card that could become one, and
most of them never do. So the card sits quiet until somebody declares the
intent, and pressing **Kirim duluan** is that declaration.

Waiting for a full order remains the silent default. No fee ever appears for a
parcel that was not going to be sent.

## What is added

### `adjustments.auto` — ownership

```sql
ALTER TABLE adjustments ADD COLUMN auto boolean NOT NULL DEFAULT false;
```

The reconciler reads and writes only `auto = true`. Everything typed by a
person is invisible to it and cannot be rewritten or deleted.

Matching on the description instead would work until somebody types the same
words — and the owner has been doing exactly this by hand for months, so the
wording the system wants to reserve is the wording a person would reach for.
The failure would be silent and unrecoverable from the screen. One column
removes the class of bug rather than managing it.

Existing rows default to `false`, which is correct: all nine of them are the
owner's.

### `customer_shipping_prefs.set_by` — attribution

```sql
ALTER TABLE customer_shipping_prefs
  ADD COLUMN set_by text NOT NULL DEFAULT 'customer';
```

`'customer'` or `'shop'`. Staff recording a plan writes `'shop'`, and her
catalogue page says *diatur oleh Yubisayu* rather than showing a choice she
does not remember making.

Without it, a staff-recorded merge is indistinguishable from her own, and the
first thing she might do is change it — undoing a parcel plan already packed.

### `shipments.weight_charged` — what the courier actually charged

```sql
ALTER TABLE shipments ADD COLUMN weight_charged integer;
```

`NULL` means the estimate was right, which is most parcels and requires nothing
to be recorded. A value means JNE disagreed.

`weight_estimation` already stores `CEIL(kg)` — billed kilos, not raw grams —
so this is a whole number matching the receipt.

## Staff controls

### Which rules apply to whom

`setShippingMode` refuses a plan for three reasons. Two are facts about the
world and stop everyone. The third is a policy about customers, and the shop is
not a customer:

| refusal | customer | staff |
|---|---|---|
| `unpaid` — the trip is not settled | blocks | **skipped** |
| `shipped` — the parcel already left | blocks | blocks |
| `unknown` — no order on that trip | blocks | blocks |

Left in place, `unpaid` breaks the feature in two ordinary situations.

A merge is arranged *before* the customer pays — that is the point, so the
discount is on the invoice she settles. Blocking it until she has paid means
the saving can only ever arrive too late.

Worse, a split cannot be undone. Declaring one writes a fee, the fee makes her
unpaid, and clearing the split now trips the rule — so cancelling a parcel you
have decided not to send requires her to first pay for it.

Staff therefore pass a flag that skips only the payment check. The other two
are unchanged for both callers.


### Kirim duluan

On a partly-arrived card. Pressing it writes `mode = 'split'`, `set_by =
'shop'`, and the reconciler prices the plan. Pressing it again clears both and
the fee goes with them.

### Gabung jadi 1 box

Across a customer's trips, including one that has not arrived — a pairing
survives a partial shipment, which is what lets the whole plan be settled once.
Writes a shared `merge_key` with `set_by = 'shop'`, so the cards genuinely
travel together rather than only the discount existing.

The credit is named the owner's way: `Gabung ongkir dengan LSFT202607`.

### Correcting a weight

Inline on the Shipments page, beside the tracking number that already edits
this way. It changes what a customer owes, so it confirms rather than saving
quietly.

A corrected row carries a scales icon next to the resi, where the
temporary-address marker already sits, so a corrected parcel is findable while
scanning. Untouched rows carry no mark — which is what makes the marked one
visible.

The difference becomes its own adjustment, not an edit to the split fee:

```
Ongkir kirim duluan                  + Rp 25.000   auto
Selisih ongkir JNE (2 kg → 3 kg)     + Rp 25.000   auto
Diskon langganan                     − Rp 10.000   yours
```

Two auto rows because they answer different questions — what splitting cost,
and what the estimate missed. Folded into one number, a change in either would
be indistinguishable.

## What she is told

Every automatic adjustment sends a notice, through the same
`sendInvoiceNotice` path the mark-created refunds use, in the same transaction.

This is load-bearing rather than a courtesy. **The customer never sees an
adjustment's description.** The WhatsApp invoice adds every adjustment into a
single `Biaya Lainnya` line, and her catalogue page reads three aggregate
numbers from a view where adjustments are not readable at all. Both are
existing, deliberate behaviour.

So without a notice she sees a number that grew and has to ask why. The notice
is the only surface that explains itself.

| surface | amount | description |
|---|---|---|
| Adjustments page · staff | yes | in full |
| Invoice page · staff | yes | in full |
| WhatsApp invoice · her | lumped | no |
| Catalogue page · her | balance only | no |
| **Notice · her** | yes | **in her own words** |

A weight correction's notice says what happened and apologises: she is being
charged after the parcel left, for something she did not cause.

## No override

The computed row is the shop's arithmetic and stays correct. To waive a fee or
be generous, the owner adds a manual adjustment beside it — which is what she
already does, and what `auto` keeps safe. The invoice then shows both the cost
and the kindness as separate facts.

An editable computed row would have to freeze to stop the reconciler undoing
the edit, and a frozen row stops tracking reality — the worst of both.

## Files

| file | change |
|---|---|
| `supabase/migrations/116_*.sql` *(new)* | the three columns |
| `lib/db/parcel-plan.ts` *(new)* | the reconciler: compute, then make the row match |
| `lib/db/shipping-prefs.ts` | accept and store `set_by` |
| `lib/db/fulfillment.ts` | call the reconciler at each trigger; record and expose a charged weight (shipments live here, not in a file of their own) |
| `lib/notice-templates.ts` | wording for a fee, a credit, and a weight correction |
| `app/api/sheets/ship/plan/route.ts` *(new)* | staff declare or clear a split or a merge |
| `app/api/sheets/shipments/route.ts` | PATCH a charged weight |
| `app/dashboard/ship/ShipClient.tsx` | the two controls, and what the plan costs |
| `app/dashboard/shipments/ShipmentsClient.tsx` | the editable weight and its icon |

## Testing

The arithmetic is already tested. What is not yet true, and must be:

- running the reconciler twice changes nothing the second time
- un-merging removes exactly what merging added, leaving no row
- a plan that costs nothing writes no row at all, and deletes one that exists
- the reconciler never reads, updates or deletes a row with `auto = false`,
  including one whose description matches its own exactly
- declaring a split raises the outstanding, and the card cannot ship until paid
- clearing a split that was already paid leaves the customer overpaid, and that
  overpayment appears in the refunds To-check list
- a corrected weight prices a second, separate adjustment and leaves the split
  fee alone
- a correction back to the original weight removes the difference row
- both worked examples: 1 kg split in half charges, 5 kg split 2 + 3 does not
- a staff-recorded plan is marked `set_by = 'shop'` and a customer's own is not

## Not in this spec

- Charging for a split the shop chose to make. The fee follows a declared
  plan; a parcel sent early for the shop's own reasons is the shop's cost.
- Any change to how the invoice bills ongkir in the first place.
- Showing adjustment descriptions to the customer. The notice carries the
  explanation; the invoice carries the number.
- Partial waivers, or editing the computed figure.
- Backfilling the nine hand-typed discounts. They stay exactly as written.
- Recording a real weight for parcels where the estimate was right.
