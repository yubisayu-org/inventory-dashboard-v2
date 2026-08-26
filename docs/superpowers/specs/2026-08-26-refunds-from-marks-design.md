# Refunds From Marks — Design

**Date:** 2026-08-26
**Branch:** not started
**Status:** approved in brainstorming, not yet planned

## Goal

A refund should exist because somebody recorded a reason, not because
arithmetic noticed a gap.

Today the Refunds pending tab is filled almost entirely by
`materializeOverpaymentRefunds` — 224 of 232 live refunds. It compares what a
customer paid against what they are invoiced and, where paid is larger, writes
a row reasoned `overpayment` with the note *"Auto-detected: paid Rp X of Rp Y"*.
The row is correct about the money and silent about the cause, and the customer
is told nothing.

The causes are already recorded elsewhere. The Shopping List marks an item sold
out; the Receiving List marks a parcel's contents missing, broken or wrong.
Those marks reduce the order and stop. This design makes them create the refund
and tell the customer, with the reason they already know.

## What the audit log says

Of the 224 live overpayment refunds, split by whether that customer's order
units ever shrank on that trip (`audit.audit_log`, `orders` UPDATE where the
new `unit` is lower than the old):

| | refunds | value |
|---|---:|---:|
| units were reduced — a mark would have covered it | 94 | Rp 43,311,000 |
| no reduction — a true overpayment | 130 | Rp 5,675,100 |

Two things follow, and they decide the shape of everything below.

**The detector cannot be retired.** 130 refunds have no order reduction behind
them. Nobody marked anything; the customer simply transferred too much. No mark
will ever fire for them, and removing the detector would stop the system
mentioning money it owes.

**The detector should not be the main producer.** The reduction-driven refunds
carry most of the value, and every one of them had a knowable cause at the
moment it happened — a cause the refund does not record and the customer never
hears.

So the detector stays, behind the marks, catching only what no mark can see.

## Model

### Marks create refunds

| mark | today | reason |
|---|---|---|
| Shopping List → sold out (`markProductOutOfStock`) | reduces `unit`, logs `excess_purchase` | `unavailable` |
| Receiving List → missing (`recordNotReceived` mode `missing`) | reduces, logs `missing` | `shipping_loss` |
| Receiving List → broken (mode `broken`) | reduces, logs `broken` | `damaged` |
| Receiving List → wrong (mode `wrong`) | reduces, logs `wrong_product` | **`wrong_item`** (new) |
| Receiving List → cancelled (mode `cancelled`) | reduces, logs `customer_cancelled` | **no refund** |

`wrong_item` is a new entry in `REFUND_REASONS`, deliberately not folded into
`other`: a wrong delivery is a distinct thing that happened and the pending tab
should say so.

`cancelled` creates no refund here. The customer asked to cancel; that path
already exists on the Arrival List and the invoice line and is not what this
design is about.

> **Parked, decided later.** Whether the `cancelled` mode should leave the
> Receiving List altogether is a separate question, deliberately not settled
> here. This spec assumes it stays and simply produces no refund, so nothing
> below depends on the answer either way.

### A reduction only owes a refund if it was paid for

This is the rule most likely to be got wrong, and the reason a mark cannot
simply refund the value of what it removed.

Reducing an unpaid order lowers what the customer owes. Nothing is owed back.
Creating a refund there invents a debt.

So each mark computes, per affected customer:

```
owed = min(value of the units removed, max(0, total_paid − invoice_total_after))
```

`invoice_total_after` is the live figure the rest of the app already uses:
`subtotal + ongkir × CEIL(gram/1000) + adjustments`, evaluated after the
reduction. `owed = 0` creates nothing.

The detector arrives at the same number by a different route, which is what
makes it a safe backstop rather than a competitor.

### Partial marks

A mark can remove some of a customer's units and leave the rest. The refund is
for the units actually removed, capped by what that customer has overpaid.
Several customers are usually affected by one mark; each gets their own refund
and their own notice, or neither.

### Undoing a mark cancels its refund

An undone mark sets its refund to `cancelled` rather than deleting it, matching
how the detector already retires rows it no longer believes in — history is
kept and the pending tab is not haunted.

A refund with a linked payment is never auto-cancelled. That guard exists today
in the detector (`NOT EXISTS (SELECT 1 FROM payments WHERE refund_id = r.id)`)
for exactly this reason: once money has moved against a refund it belongs to a
person, not a process.

### The notice goes with the refund, automatically

Each mark-created refund is accompanied by a customer notice, sent in the same
transaction, through `sendInvoiceNotice` in `lib/db/notices.ts`. That path
already does this and says why:

> *The notice and whatever it announces are one action. A refund notice that
> does not create the refund promises money the system has no record of.*

The wording lives in `notice_templates` (migration 114), so it is the owner's to
change without a deploy. One template per reason.

### The detector becomes a backstop

One line in `materializeOverpaymentRefunds`:

```diff
   LEFT JOIN refunds r ON r.event = l.event AND r.customer = l.customer
-    AND r.reason = 'overpayment' AND r.status != 'cancelled'
+    AND r.status != 'cancelled'
```

Any live refund for that customer and trip now stands it down, not only an
`overpayment` one. Without this it would add a second row beside every
mark-created refund, because the invoice fell and the payment did not.

Its `reconciled` and `cancelled` passes stay scoped to `reason = 'overpayment'`
so they never rewrite or retire a mark's row.

**Known limitation, accepted.** A customer with a mark-created refund who *also*
genuinely overpaid gets only the first until somebody looks. The alternative —
topping up by comparing amounts — risks quietly under-refunding, which is worse
than a visible gap. The Dashboard's overpayment-candidate count still surfaces
these.

## Files

| file | change |
|---|---|
| `lib/db/types.ts` | add `wrong_item` to `REFUND_REASONS` |
| `lib/db/refund-owed.ts` *(new)* | the `owed` calculation, pure and tested |
| `lib/db/shopping-list.ts` | `markProductOutOfStock` creates refunds + notices |
| `lib/db/fulfillment.ts` | `recordNotReceived` does the same for missing/broken/wrong |
| `lib/db/finance.ts` | widen the detector's guard |
| `supabase/migrations/1xx_*.sql` | notice templates for the new reasons |

## Testing

The arithmetic is where money goes wrong silently, so it is extracted and
tested directly rather than through a mark:

- an unpaid customer's reduction creates no refund
- a partly-paid customer is refunded only what they overpaid, not the units' value
- a fully-paid customer is refunded the units' value
- several customers on one mark each get their own amount
- undoing a mark cancels its refund, and leaves one with a linked payment alone
- the detector adds nothing when a mark's refund is live, and still fires for a
  true overpayment with no mark behind it

That last pair is the whole design in two tests.

## Not in this spec

- Retiring the detector. The 130 refunds it alone can see rule it out.
- Marks writing adjustments to move the invoice itself.
- Any change to the cancellation flow.
- Backfilling reasons onto the 94 historical reduction-driven refunds.
