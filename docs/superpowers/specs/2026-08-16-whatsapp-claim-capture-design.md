# WhatsApp Claim Capture — Design

Date: 2026-08-16
Branch: `feat/whatsapp-product-post`

## Problem

Selling happens in WhatsApp groups. A photo goes up, customers reply to claim
items, and the owner transcribes those replies into orders by hand. Writing the
post takes thirty seconds; reading forty replies back out of a group chat takes
an evening.

The automation worth building is therefore on the **read** side, not the write
side. Posting stays manual — it is cheap, and it is where the seller's voice
lives. (JastipMate, the closest comparable product, reaches the same conclusion:
"Seller tetap post item di grup. Gaya jualan tetap natural.")

## Goals

- Capture claims out of group replies without hand-transcription.
- Answer "how many of each do I buy" as a picture the owner can shop from.
- Preserve who claimed what, so orders can be created afterwards.
- Zero per-claim cost. No LLM in the capture path.

## Non-goals

- Auto-posting products to the group.
- Replacing the existing purchase → arrival → packing-list flow. This feeds it.
- Any change to invoicing.

## The unifying model

Two kinds of post, one pipeline:

> **A photo has claimable slots. A reply resolves to one or more slots with a
> quantity.**

Only the origin of the slots differs:

| Post type | Slots | Resolver |
|---|---|---|
| Shelf photo (many products in one shot) | **Discovered** — nobody knows them in advance; claim positions cluster into them | Ink detection, crop matching |
| Product photo/video (one product, many variants) | **Declared** — colour × size listed in the post's note | Text matching against the closed set |

Everything downstream — counting, partial buying, allocation, order creation —
is identical for both.

## Claim resolvers

All three are pure computation. No model, no API, no per-claim cost.

### 1. Marked image (shelf)

Customer ticks or circles items using WhatsApp's pen and sends the image back.

WhatsApp's pen colours are heavily saturated; product photography is not. Marks
are found by thresholding on saturation in the reply image **alone** — no
comparison against the original, and therefore no image registration. This
matters: replies come back re-encoded, resized, sometimes cropped, so aligning
two images would have been the hardest part of the build and it is avoided
entirely.

Each mark yields a point in the reply's coordinate space, normalized to the
original's.

### 2. Cropped image (shelf)

Customer crops the original photo down to the item they want and sends that —
no ink at all.

A crop is an exact sub-rectangle of a known image, so it is located by template
matching: downscale both to a few hundred pixels, coarse-to-fine search, take
the best-scoring position. The match score is free confidence — when the top
match beats the runner-up by a wide margin it is certain; when two shelf
positions score alike (repeated stock, a crop showing only fabric texture) the
claim goes to review rather than being guessed.

### 3. Text (both post types)

For a variant post, the reply is words: "hitam 38", "yg merah ukuran 40 dong",
"38 item x2".

The post carries a **note** listing its variants — free text, typed when
posting, e.g. `hitam/merah/putih, 38-42`. The parser matches replies against
that closed set. Matching fifteen known options is a far easier problem than
parsing open-ended Indonesian, which is why no per-variant short codes are
needed in the caption: the caption stays human, the structured list stays
internal.

An incomplete claim ("38" when three colours exist) triggers a bot reply asking
for the missing dimension. The answer completes the claim.

Shelf posts also accept typed claims where the owner has numbered items, but
numbering is optional and not required by the design. Free-text claims against
an **un-numbered** shelf photo ("yang bunny 2") have no closed set to match
against and no position to derive — they are the one reply shape with no free
automatic path, and go to review.

## Acknowledging claims: reactions

Every claim message gets an emoji reaction from the bot:

| Phase | Reaction | Meaning |
|---|---|---|
| Capture | 📝 | Understood and recorded |
| | ❔ | Partly understood — a dimension is missing (size but no colour). The only case that also earns a text reply. |
| | ❌ | Could not be read; the customer should retype |
| After buying | ✅ | Secured for this customer |
| | 😢 | Not obtained — sold out, or lost the allocation when short |

The split is deliberate: 📝 means *noted*, ✅ means *done*. A customer glancing
at their own message can tell the difference between "we heard you" and "it's
yours" without reading anything.

WhatsApp permits one reaction per message per sender, and a new reaction
replaces the old, so a claim **advances** through these states rather than
accumulating them. A customer gets 📝 within seconds of claiming; days later,
when the owner taps counts in the store, the same message flips to ✅ or 😢.

This is what makes the fulfilment result deliverable at zero cost: nobody
receives a DM, the owner writes nothing, and each customer learns their outcome
by looking at their own message. The 😢 case matters most — when a short
purchase is allocated by priority, the customer who missed out is told without
anyone having to compose an awkward message.

Both states are visible to the whole group, which is consistent with the claim
itself having been public. Making the outcome private would require a DM per
customer, and therefore a message per customer.

Reactions are preferred over text acknowledgements: they carry no notification
weight, do not clutter the group, and are a much smaller activity signature on
the bot number than a message would be.

They are also **mutable**. A claim that resolved to ❌, or one corrected in the
review queue, has its reaction updated to 📝 afterwards — the customer sees
their claim accepted without the owner writing anything. Note that a correction
resolves to 📝, not ✅: the claim is now recorded, not yet bought.

Recording a purchase updates many reactions at once: buying forty items flips
forty claims. That burst must be **throttled and spread out**, since a rapid
volley of reactions is precisely the automated signature the bot number should
not exhibit.

Quantity is the one thing a checkmark cannot confirm. Number-emoji reactions
(2️⃣) are an option if customers turn out to be unsure what quantity was
recorded; the shopping-list post already carries the totals, so this starts off.

## Slots, clustering, quantities

Claim points that land near each other are one slot. The cluster radius is a
tunable threshold, and it will occasionally merge two adjacent items or split
one — the annotated photo is the review surface for exactly this, and the owner
is looking at it before shopping anyway.

For declared-variant posts there is no clustering: the slot is whichever
variant the text resolved to.

A slot carries:

- **claimed** — total quantity across all claims
- **bought** — how many were actually purchased
- the list of claims behind it, each with its sender

### Claims are unbounded

There is no stock figure to enforce against. A shelf photo shows what was on the
shelf at that moment; the seller does not know the real count, and the same is
true of a product photo or video. So **no claim is ever rejected for exceeding
stock**. `claimed` is a measure of demand, not an allocation.

Reality is applied at the buy step instead: the owner buys what is actually
there, records that as `bought`, and `compareOrderPriority` decides who gets
them. Over-claiming is useful signal — eighteen claims on a slot says buy extra,
or find another store.

A stock figure written into the caption ("stock only 16") is therefore
**advisory**: the shopping list renders `18 claimed / 16 stock` so the owner
knows before walking in, but claim 17 still records and still gets a 📝. Having
the bot tell a customer "sold out" on the strength of a number guessed from a
photograph would be worse than over-collecting.

Hard first-come-first-served cutoffs are deliberately not built: that is a
different social contract with customers, and it would commit the seller to a
number they only estimated.

## Output: the shopping list

Rendered from the original post plus its slots.

- **Shelf photo** — the original image with a badge on each slot: `4/5` where
  five were claimed and four bought. Incomplete slots stay visibly open.
- **Variant post** — a table instead of badges, since variants have no position
  on the image.

Available two ways:

- **Live in the dashboard.** Claims arrive over hours, so this is the source of
  truth and is always current.
- **On demand in the group.** A command (`/rekap`) renders it fresh and posts
  it. Group-visible to start; a setting flips it to owner-only DM if customers
  turn the tally into a pile-on.

The shopping list is **never sent automatically**. Claims arrive over hours, so
any unprompted snapshot is stale on arrival and would have the bot posting the
same picture repeatedly — noise in the group, and the most obvious repetitive
sending pattern the number could exhibit.

`/rekap` is **admin-only**: the sender is checked against an allow-list of
permitted numbers and the command is silently ignored from anyone else.
Silently, not with an error reply — a customer who types it should get no
response at all, rather than a message that invites them to try again.

The app's own roles (`owner` | `admin`) key on **email** — see
[lib/roles.ts](../../../lib/roles.ts) and its `ADMIN_EMAILS` list. A WhatsApp
sender has a number and no login, so the bot cannot reuse that check and needs
its own allow-list of admin numbers. Keeping it a list rather than a single
owner number means staff who help run an event can pull the shopping list too,
without sharing one phone.

## Partial buying

The owner buys 4 of the 5 claimed today and may find the last one tomorrow.

In the store, the only interaction is tapping a slot and entering how many were
obtained. The photo re-renders with `4/5` and the open slot stays visible.
Naming products, matching to the catalogue, creating orders — all of it waits
until the owner is back at the hotel. This mirrors the existing `unit` vs
`unit_arrive` split that already produces "Tiba Sebagian" on the packing list.

**Allocation when short:** reuse `compareOrderPriority` in
[lib/db/fulfillment.ts](../../../lib/db/fulfillment.ts) — paid customers first,
then partial, then unpaid. This is already the app's answer to "not enough units
to go around" when arrivals land; a short purchase is the same question one
stage earlier.

## Identity: WhatsApp number → customer

Customers are keyed by Instagram handle everywhere (orders, invoices, payments,
the public invoice site). WhatsApp supplies a phone number. The bridge:

1. **Match on file first.** `customers.whatsapp` already exists
   (`000_init.sql:29`). Normalize both sides (strip `+`, leading `0` → `62`) and
   look the sender up. Many customers already resolve with no interaction.
2. **Ask once, remember forever.** No match → the bot replies to that customer
   asking for their IG handle, stores it against the customer record, and every
   future claim from that number resolves instantly.
3. **Manual link in review** for anyone who never answers.

Auto-creating customers keyed by phone is explicitly rejected: it would build a
second customer namespace that drifts from the IG-handle one the rest of the
system depends on.

## Deferred naming

Slots do not need to know what they are in order to be counted. Identity is
assigned **once per slot, after purchase** — the owner names it, which creates
the product row (following the existing convention where the variant is spelled
into the name: `Grey Set M`, `Outer Shawl Beige`) and the order lines behind it.

Consequences worth stating:

- The catalogue only grows by variants that actually sold. Post fifteen
  combinations, three get claimed, three product rows exist.
- The boring work happens once, later, on the items that matter — not up front
  on every item including the ones nobody wants.
- Variants of one product share a price, so the post carries one price and every
  variant inherits it.

## Connecting a group

Follows the pattern JastipMate uses, which avoids per-seller session pairing:

1. Invite the bot number to the WhatsApp group.
2. Send a connect command in the group carrying a token that identifies the
   account.
3. The group attaches to the active event.

Groups persist across events and are attached/detached per event, rather than
being recreated.

Group **JID** is the stable key; the group **name** is cached locally and
refreshed on demand with a cooldown — live lookups against WhatsApp are the kind
of chatter that draws spam attention.

## Infrastructure

- **Bot session.** An unofficial multi-device library (Baileys) holding a real
  WhatsApp account. The official Cloud API has no group support at all, so there
  is no compliant alternative for this feature.
- **Host.** A persistent worker; serverless cannot hold the session. Railway,
  alongside the existing [railway.json](../../../railway.json).
- **Number.** A dedicated SIM, never the business number. Whatever number joins
  the groups carries the ToS risk; if it is banned, the loss is that number, not
  the customer relationships.
- **Bot speech.** Reply-only — the bot messages someone only in response to
  their own message, throttled. Cold DMs are what get numbers banned. Both
  features that need it (asking for an IG handle, asking for a missing colour)
  fit inside reply-only, and reactions carry most of the acknowledgement load
  without sending messages at all.
- **Storage.** Posted photos and reply images. Given the existing work on
  Supabase egress, retention needs an explicit decision: likely discard reply
  images once their claim is confirmed, keep the original post.

## Data model

New tables (migrations from **062** upward — 058–060 are taken by the
`catalogue-order-requests` branch, 061 by Target Price):

- **whatsapp_groups** — JID, cached name, refreshed-at, active event.
- **posts** — the image, the group, the event, the note (variant list), price.
- **claims** — post, sender number, resolved customer, source
  (`ink` | `crop` | `text`), point or variant, quantity, confidence, review
  state, and the source message id (needed to update its reaction later).
- **slots** — post, position or variant, claimed qty, bought qty, assigned
  product once named.

## Risks

- **The pixel resolvers are unproven.** Ink detection and crop matching must be
  validated against real WhatsApp-compressed samples before they are built. If
  the signal is poor, the design survives unchanged but those two resolvers
  degrade to "everything goes to review".
- **Ban risk is real and unmitigable.** Reply-only and throttling reduce it; a
  dedicated number contains the blast radius.
- **Clustering thresholds will misfire** on tightly-packed shelves. The
  annotated photo is the correction surface.
- **Session drops silently.** Needs a health check, or claims stop being
  captured with no visible failure.

## Open items

- Sample images on disk (original, ticked reply, cropped reply) to validate the
  resolvers.
- Retention policy for reply images.

## Deferred

- **Over-demand alert.** Notify the owner when a slot's claims pass the stock
  figure written in its caption, rather than leaving it to be noticed on the
  shopping list. Held back deliberately until one event has run and the real
  frequency is known — building it now would be guessing at a threshold nobody
  has observed yet.
