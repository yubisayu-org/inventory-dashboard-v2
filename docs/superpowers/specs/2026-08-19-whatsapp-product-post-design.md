# WhatsApp Product Posts — Design

**Date:** 2026-08-19
**Branch:** `catalogue-order-requests` (continuing here — see "Data model" below)
**Status:** approved in brainstorming, not yet planned

**Revision note:** the first version of this spec built four standalone
tables (`wa_product_posts`, `wa_product_items`, `wa_product_claims`,
`wa_code_offers`) because `catalogue-order-requests` wasn't available to build
on. It has since been merged with `development`'s latest and is close to
shippable — a real object already exists there (`catalogue_posts` + tagged
products + `catalogue_requests`) that is the same object this feature needs,
under different names. This revision unifies onto it instead of duplicating
it. See "Data model" for the concrete shape and what changed.

## Goal

Post products that are **already in the catalogue** to the WhatsApp group, let
customers claim them by a short code, and turn approved claims into ordinary
orders at the catalogue price.

This is not a shelf. A shelf photo is an unknown — its items have no name, no
price, and no product until the owner names them. A product post is the
opposite: every line is a product that already exists, priced, with a country
and a store. Nothing is discovered; the only unknown is who wants what.

## What the customer sees

The bot posts one photo and a caption listing each product with a code:

```
📦 MUJI restock

K41 Boston Bag 38L Greige — Rp 385.000
K42 Boston Bag 38L Black — Rp 385.000
K43 Shoulder Bag 9L Beige — Rp 210.000

Reply kodenya ya, contoh: K42 mau 1
```

She replies `K42 mau 1`. The bot reacts 📝. The claim waits in an inbox until
the owner approves it, and approval writes the order.

## Codes

- Format: one letter then two digits — `K42`. Three characters, thumb-typable.
- Alphabet excludes **I, O, S** — they read as 1, 0 and 5 in the group's font
  and in handwriting. **Q is included** (the owner's call: Q and 0 are not
  confusable in the sans-serif WhatsApp renders).
- 23 letters × 100 digits = **2 300 codes per trip**, far past any real trip.
- Codes are issued sequentially per event, starting at `A01`, and **restart
  every trip**. LSJP's `A21` and LSKR's `A21` are different products and never
  collide, because a code is only ever looked up as **(event, code)** — never
  as `A21` alone:
  - She *quotes* a post → the quoted message id names the post → the post names
    its event.
  - She *types* with no quote → resolved against the **active event bound to
    that group**. One group is bound to one event, so exactly one `A21` is live.
- Consequence, deliberate: replying to a **closed** trip's post resolves to that
  closed trip and is refused, rather than silently landing on the live trip's
  product of the same code.

Per-post restarts were rejected: two posts in one trip would both carry `A21`,
and an unquoted `A21 mau 1` would have no answer. Forever-stable codes were also
rejected — uniqueness across 6 817 products forces four or five characters.

**A store's own product code (e.g. `2099A1` on ZHG items) is not reused as the
reply code.** It is a different kind of thing — a durable, product-level label
— while the trip code is deliberately throwaway: short, exclusion-alphabet, and
restarted every trip. Reusing it for replies would also break the scheme it
exists to serve: six mixed alphanumeric characters are slow to thumb-type,
carry no I/O/S-style confusion guard, don't fit `parseCodes`'s shape, and
don't reset per trip.

These codes already live as the first token of `products.name` (e.g.
`"2099A1 - Buckle Shoulder Bag Brown"` — there is no separate column for
them), so nothing needs to be built to keep them visible: the caption prints
`products.name` as-is after the trip code, and the store code rides along for
free —

```
K42 2099A1 - Buckle Shoulder Bag Brown — Rp 840.000
```

Customers are not required to switch to it, either. A ZHG regular who already
says *"fix 2099A1 kak"* keeps working exactly as before: `2099A1` is a unique
token inside a tagged product's name, so the word-matching path in "Resolving
a reply" below resolves it as a **direct claim**, not a guess that needs
confirming — an exact, unique token carries the same confidence as a typed
code. `K42` is offered for everyone else, but it is a second door, not a
replacement one.

## Data model — migration 075

`catalogue-order-requests` already has the object this feature needs:
`catalogue_posts` is one media asset with a caption, tagged to several
products via `catalogue_post_products`; `catalogue_requests` — handle,
product, qty, note, `pending`/`converted`/`rejected`, `converted_order_id` —
is already the Setuju/Tolak inbox, under different names. Building a second,
parallel set of tables for "post a photo of tagged products" and "an inbox
of qty requests against them" would give the dashboard two of everything: two
upload screens, two media buckets, two product-tagging UIs, two inboxes. This
revision adds only what's actually new — the WhatsApp-specific layer — on top
of what's already there:

```
catalogue_posts          media, caption, tagged products      (exists)
  ├─ visible              the public catalogue                (exists)
  └─ wa_sends             one row per trip it is sent to       NEW
       └─ wa_send_codes   product -> K42, price snapshot, pin  NEW
```

`wa_sends` is the repost model: the same `catalogue_posts` row sent to LSJP
and, later, LSKR is two `wa_sends` rows — each with its own event, its own
codes, and its own price snapshots — no second upload, no second file. And the
inbox merges: a WhatsApp claim and a public-catalogue request are the same
kind of row — someone wants N of a product, the owner approves or rejects, and
approval writes an order — so `catalogue_requests` gains a `source` column and
a handful of WhatsApp-only fields, rather than a second inbox living beside it.

This lands on `catalogue-order-requests` itself (not a branch built on top of
it), so there is no merge-order dependency and no migration-number collision
to plan around — migration **075** is simply the next free number here.

```sql
-- One trip a catalogue post is sent to. A repost of the same post to a later
-- trip is a second row here, not a new catalogue_posts row — same photo, same
-- tagged products, new event and new codes.
CREATE TABLE wa_sends (
  id         SERIAL PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES catalogue_posts(id) ON DELETE CASCADE,
  event      TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE,
  -- The caption's first line for this trip: "MUJI restock". Independent of
  -- catalogue_posts.caption, which is the public-catalogue-facing text and
  -- may read differently or not exist at all for a WhatsApp-only post.
  title      TEXT NOT NULL DEFAULT '',
  -- Set once the bot has posted it. A reply quoting this resolves here.
  message_id TEXT NOT NULL DEFAULT '',
  group_jid  TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX idx_wa_sends_post ON wa_sends (post_id);
CREATE INDEX idx_wa_sends_event ON wa_sends (event);
CREATE INDEX idx_wa_sends_message ON wa_sends (message_id) WHERE message_id <> '';

-- One line of a send: a tagged product, under a code, at the price it was
-- posted at. Which products can appear here is bounded by
-- catalogue_post_products — a send can only code products already tagged to
-- its post.
CREATE TABLE wa_send_codes (
  id         SERIAL PRIMARY KEY,
  send_id    INTEGER NOT NULL REFERENCES wa_sends(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  code       TEXT NOT NULL,
  -- Redundant with wa_sends.event, but a code is looked up as (event, code)
  -- on every incoming message — a join back through wa_sends for that would
  -- be paid on every reply, for a column that never changes after insert.
  event      TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE,
  -- The price printed in the caption. Snapshot, not a live read: the group
  -- was quoted this number, and repricing the product tomorrow must not
  -- silently change what a customer agreed to yesterday.
  price      NUMERIC(14,2) NOT NULL,
  -- Where the code was pinned on the photo, normalized 0..1. Null when the
  -- owner did not pin it — a caption line is enough for most posts.
  point_x    DOUBLE PRECISION,
  point_y    DOUBLE PRECISION,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wa_send_codes_send ON wa_send_codes (send_id);
-- A code is unique within a trip, which is what makes an unquoted "K42 mau 1"
-- resolvable without also naming the send.
CREATE UNIQUE INDEX idx_wa_send_codes_code ON wa_send_codes (event, code);

-- catalogue_requests becomes the one inbox for both a public-catalogue
-- request and a WhatsApp claim.
--
-- product_id is ALREADY nullable and status ALREADY carries offer_pending/
-- approved — both added by 076_custom_catalogue_requests.sql and
-- 079_custom_request_edit_approval.sql, the custom-request/edit-approval
-- work this branch picked up in the merge that brought it current. This
-- migration extends what is actually there rather than the base shape this
-- spec was first written against — see "A note on sequencing" below.
ALTER TABLE catalogue_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'catalogue'
  CHECK (source IN ('catalogue', 'whatsapp'));

ALTER TABLE catalogue_requests ADD COLUMN send_id INTEGER
  REFERENCES wa_sends(id) ON DELETE CASCADE;
ALTER TABLE catalogue_requests ADD COLUMN send_code_id INTEGER
  REFERENCES wa_send_codes(id) ON DELETE SET NULL;
-- Her WhatsApp number and the message id of her claim, verbatim — the latter
-- is what the closing "sudah dicatat" reply quotes.
ALTER TABLE catalogue_requests ADD COLUMN sender TEXT NOT NULL DEFAULT '';
ALTER TABLE catalogue_requests ADD COLUMN message_id TEXT NOT NULL DEFAULT '';
-- The message id of the BOT'S OWN disambiguation question (distinct from
-- message_id above, which is hers). A 👍 reaction names the message it lands
-- on — this is how it is matched back to this row.
ALTER TABLE catalogue_requests ADD COLUMN bot_message_id TEXT NOT NULL DEFAULT '';
-- Populated only while status = 'asking' with two or more candidates — the
-- codes the bot listed, so a code reply or an inbox pick resolves against
-- exactly what she was shown, not the full send.
ALTER TABLE catalogue_requests ADD COLUMN candidate_send_code_ids INTEGER[];

-- Add 'asking' to the existing status list, changing nothing else in it.
ALTER TABLE catalogue_requests DROP CONSTRAINT catalogue_requests_status_check;
ALTER TABLE catalogue_requests ADD CONSTRAINT catalogue_requests_status_check
  CHECK (status IN ('pending', 'offer_pending', 'approved', 'asking', 'converted', 'rejected'));

-- The custom-request path already requires product_id OR a free-text
-- description. Widen that existing rule rather than adding a second,
-- independent one beside it — CHECK constraints AND together, so a second
-- constraint written as this spec first had it (product_id IS NOT NULL OR
-- status = 'asking') would itself have rejected every asking row, since an
-- asking row's description is also empty.
ALTER TABLE catalogue_requests DROP CONSTRAINT catalogue_requests_product_or_description;
ALTER TABLE catalogue_requests ADD CONSTRAINT catalogue_requests_product_or_description
  CHECK (product_id IS NOT NULL OR description <> '' OR status = 'asking');

CREATE INDEX idx_catalogue_requests_send ON catalogue_requests (send_id);
CREATE INDEX idx_catalogue_requests_asking
  ON catalogue_requests (id) WHERE status = 'asking';
```

### A note on sequencing

This spec was first drafted against `catalogue-order-requests`' base shape —
`product_id NOT NULL`, status only `pending`/`converted`/`rejected`, no
`description`. Since then, `custom-order-requests` (a second branch stacked
on that same base, built independently this session for an unrelated
feature — customer-submitted custom requests with owner price offers) was
merged into this branch too, at the user's request, so both features live on
one branch instead of two. That merge already made `product_id` nullable and
already extended `status`, for its own reasons. The migration above targets
what is actually on this branch **after** that merge — confirmed directly
against the local dev DB, not assumed from an earlier read of the schema.

### Why one row, not a separate pre-claim table

The alternative considered was a small `wa_code_offers` table — mirroring the
already-shipped `wa_size_offers` (migration 069) — holding the ambiguous
reply until it resolves, only inserting into `catalogue_requests` once it
does. Rejected: it would mean two writes instead of one when an offer
resolves, a second query and a second visual section in the inbox for open
offers, and a second concept ("offer" vs "request") for what is, from the
owner's side, one thing happening at one point in time — someone asked to buy
something, and it took a moment to work out what.

The precedent actually points the other way. `wa_size_offers.claim_id` is
`NOT NULL REFERENCES wa_claims(id)` — the claim row already exists before the
offer is created, refined in place. The `asking` status here does the same
thing one level up: the `catalogue_requests` row is created the moment the
ambiguous reply arrives, `product_id` null, and is updated in place — never
replaced — once either side resolves it.

### Outbox

`wa_outbox.post_id` is `NOT NULL REFERENCES wa_posts(id)` — shelves only.
Migration 075 makes it nullable, adds `send_id`, and requires exactly one:

```sql
ALTER TABLE wa_outbox ALTER COLUMN post_id DROP NOT NULL;
ALTER TABLE wa_outbox ADD COLUMN send_id INTEGER
  REFERENCES wa_sends(id) ON DELETE CASCADE;
ALTER TABLE wa_outbox ADD CONSTRAINT wa_outbox_one_target
  CHECK ((post_id IS NULL) <> (send_id IS NULL));
-- The rendered caption to send. Empty for a shelf, whose caption the worker
-- renders; generated up front for a send, since "the caption is generated,
-- not typed" — the composer's live preview and the sent message must be the
-- same text, not two renderers that can drift.
ALTER TABLE wa_outbox ADD COLUMN caption TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_wa_outbox_send
  ON wa_outbox (send_id) WHERE send_id IS NOT NULL;
```

### Delivering a dashboard action to the group

**Setuju**, **Tolak**, and an owner's pick in the ❔ picker (case C) all need
to put something in the WhatsApp group — a ✅/❌ reaction, or the case C
closing line — but they all run as a dashboard route, and the dashboard has
no socket. This is the same constraint `wa_outbox` already exists to solve
for a composed send, generalized to a reaction or a short quoted text instead
of a photo-and-caption:

```sql
-- What a dashboard action needs the worker to say or react in the group,
-- drained on the same kind of timer as wa_outbox. Exactly one of `reaction`
-- or `text` is set per row.
CREATE TABLE wa_replies (
  id                 SERIAL PRIMARY KEY,
  group_jid          TEXT NOT NULL,
  quoted_message_id  TEXT NOT NULL DEFAULT '',
  reaction           TEXT NOT NULL DEFAULT '',
  text               TEXT NOT NULL DEFAULT '',
  state              TEXT NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending', 'sent', 'failed')),
  error              TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at            TIMESTAMPTZ
);
ALTER TABLE wa_replies ADD CONSTRAINT wa_replies_one_kind
  CHECK ((reaction <> '') <> (text <> ''));
CREATE INDEX idx_wa_replies_pending ON wa_replies (id) WHERE state = 'pending';
```

A live worker action (the customer's own 👍, or a code reply it is already
handling in real time) never touches this table — it already holds the
socket and the original message in hand, and replies or reacts directly, the
same way `askWhoTheyAre` and the reaction handling in `worker/index.ts`
already do. Only a dashboard-triggered action queues here. This also
corrects the ❔ section's case C below: since the confirmation/candidates
question is always sent synchronously and immediately by the worker the
moment it detects ambiguity, it is always already in the group by the time
an owner could act on the dashboard — case C queues one closing message, not
two.

## Reposting to the next trip

The photo and the tagged products are worth keeping; only the codes are
disposable. Sending the same post again on the next trip re-uploads nothing.

A repost is a **new `wa_sends` row pointing at the same `catalogue_posts`
row**, with codes drawn from the destination trip's own running sequence —
not restarted specially for a repost — and prices re-read from the catalogue
at repost time. If LSKR is already at `K06` when a post gets reposted there,
its new codes are `K07/K08/K09`; LSJP's original send keeps whatever codes it
was given and is untouched. Pin positions (`point_x`/`point_y`) copy across
from the previous send's `wa_send_codes` rows, since it is the same
photograph — only the labels regenerate.

- **Prices are re-read live from the catalogue at repost time**, and any
  change from the previous send's snapshot is shown explicitly in the
  composer — old price struck through, new price bold, with a warning banner
  — never swallowed silently. Already-approved orders from the earlier send
  keep whatever price was snapshotted at their own claim time; a later repost
  never touches them.
- **A product no longer tagged to the post is skipped** — this needs no new
  logic: `catalogue_post_products` already cascades a tag away when a product
  is deleted, so a repost that reads the post's current tags simply won't
  find it there. No code is issued, and the composer lists it struck through
  rather than silently omitted, so the owner can see something used to be
  there. This does not block the repost — the owner's call to make, not the
  system's.
- Reposting is not editing: the earlier send's own `wa_sends`/`wa_send_codes`
  rows are untouched, and its `catalogue_requests` rows keep resolving against
  it. Quoting the old trip's post still resolves to the old (now closed)
  send and is refused per the closed-trip rule under "Resolving a reply".

### The upload step's second door

The upload step gets a second tab — **Foto baru** or **Pakai post lama** —
the latter a card grid of past `catalogue_posts`, each showing its thumbnail,
tagged-product count, most recent title, and a line like `LSJP · 12 Jun · 7
order` (trip · date · how many of its requests converted to orders), so the
owner can see at a glance which posts are worth sending again. Picking one
opens the composer pre-filled from that post — trip defaults to the current
active event, title is editable, tagged products and pin positions carry over
— exactly as if freshly composed, just not freshly photographed.

## Modules

| File | Responsibility |
|---|---|
| `lib/whatsapp/codes.ts` | The alphabet, `nextCode(event)`, `parseCodes(text)` |
| `lib/db/catalogue-posts.ts` | Existing — `catalogue_posts`/`catalogue_post_products` reads and writes; gains nothing new, reused as-is |
| `lib/db/wa-sends.ts` | `wa_sends`/`wa_send_codes` reads and writes: create a send from a post, issue codes, snapshot prices |
| `lib/db/catalogue-requests.ts` | Existing — extended for `source`, `asking`, and the WhatsApp fields; one code path for both origins |
| `lib/whatsapp/product-post.ts` | Compose a send: attach the post's tagged products, issue codes, build the caption, queue it |
| `lib/whatsapp/product-claim.ts` | Resolve an incoming message to a `wa_send_codes` row; write or update the `catalogue_requests` row |
| `lib/whatsapp/code-offer.ts` | The `asking` resolution: post the disambiguation question, settle it from either side |
| `app/dashboard/catalogue-posts/` | Existing — upload/composer screen; gains the "+" menu's *Product post* entry and *Foto baru* / *Pakai post lama* tabs |
| `app/dashboard/order-requests/` | Existing — the one inbox; gains the `source` badge and the `asking`-state radio picker |
| `app/api/whatsapp/sends/…` | Composer routes for creating and sending a `wa_sends` row |

`lib/whatsapp/codes.ts`:

```ts
/** Letters a code can start with. I, O and S are dropped: they read as 1, 0, 5. */
export const CODE_LETTERS = "ABCDEFGHJKLMNPQRTUVWXYZ"
```

## Composing a post

Entry point: the Group Order screen (`app/dashboard/shop`), which today has
an **Upload** button (shelves) and a DM-photo icon button next to the search
row. Those become a menu with a third, highlighted option — 🖼 *Upload shelf*
(existing), 📦 **Product post** (new — *"Produk yang sudah ada di katalog"*),
📎 *Paste DM order* (existing DM-photo entry, relabelled) — one new line in an
existing row, not a new screen in the sidebar.

**Product post** opens the composer at `app/dashboard/catalogue-posts`,
reusing the existing upload/tagging screen rather than a parallel one:

1. **Upload step.** Two tabs: **Foto baru** (a single photo, processed at the
   same 3 000 px / quality 70 as a shelf) or **Pakai post lama** (see
   "Reposting" above). Two fields: **Trip** (pre-filled to the active event)
   and **Judul** (free text, e.g. `MUJI restock` — becomes `wa_sends.title`).
   Button: *Lanjut ke produk*.
2. **Product step.** Server-side search, `LIMIT 20`, matching name and store —
   6 817 products cannot go in a dropdown. An already-added product is shown
   greyed with a *sudah* tag so the same line can't be attached twice. Each
   attached product is added to `catalogue_post_products` (if not already
   tagged) and takes the next free code for the trip via `wa_send_codes`,
   snapshotting its current price.
3. **Pin placement (optional).** Dragging a code onto the photo stores
   `point_x`/`point_y`, normalized 0..1. An unplaced code stays listed in the
   caption text regardless — pinning is cosmetic, not required, since a
   product post is resolved from what she types, not from where she taps.
4. **Live preview.** A right-hand panel titled *"Yang dikirim ke grup"* renders
   the exact caption the send will use — **the caption is generated, not
   typed** — kept in lockstep with the product list and price snapshots as
   they change.
5. **Two footer actions.** *Simpan draf* persists the `wa_sends` row (and its
   codes) without queuing an outbox entry — the send exists, unset
   `message_id`, nothing posted yet, resumable later. *Kirim ke grup* writes
   the generated caption into `wa_outbox` (`send_id`, `caption`) and returns;
   the worker posts it and writes `message_id` back onto `wa_sends`, exactly
   as it already does for shelves.

A send cannot be edited after it is sent — the group already has the caption.
Deleting a drafted (unsent) send removes its `wa_sends`/`wa_send_codes` rows
and cancels any pending outbox entry; the underlying `catalogue_posts` row and
its tags are untouched, since another send may still use them. There is no UI
to delete a send once it has been posted — `catalogue_requests.send_id` does
cascade if one ever is (matching the precedent this design replaced), but
that path is unexercised until a delete action is deliberately built.

## Resolving a reply

A product post is claimed by what she **types**, not by what she marks on the
photo — unlike a shelf, where a marked-up resend of the picture is the claim.
Re-sending or saving the post's photo unmarked creates nothing here; the text
is the order, and the picture is only context. Pin marking (above) exists
only so the composer can show where a code sits — it plays no part in
resolving a reply.

In the worker, before shelf handling (a product post is text-only, so nothing
here touches clustering):

1. **Quoted a send's post** → that send, and its event.
2. **Not quoted** → if the group's active event has any open send, scan the
   text for a code belonging to that event.
3. Neither → not a product claim; fall through to the existing shelf path.

Then, on the resolved send:

- **Exactly one code found** → claim on that `wa_send_codes` row. Quantity
  from the existing `parseQuantity`. React 📝. `catalogue_requests` row
  written directly with `status = 'pending'`.
- **No code, but the text contains exactly one exact, unique token from a
  tagged product's name** — a store code like `2099A1`, or a distinctive word,
  case-insensitive, unique among the send's products — → treated with the same
  confidence as a code match: **direct claim**, react 📝, `status = 'pending'`.
  An exact unique token is not a guess.
- **No code, no exact token, but the text plausibly names exactly one item**
  (a fuzzier match — partial word, colour, etc.) → open a disambiguation with
  one candidate. React ❔. `status = 'asking'`, `candidate_send_code_ids` holds
  the one row.
- **No code, several plausible candidates** → disambiguation with all of them.
  React ❔. `status = 'asking'`, `candidate_send_code_ids` holds all of them.
- **No code, no candidate at all** → react ❔ with a plain *"kodenya yang mana
  kak?"*. `status = 'asking'`, `candidate_send_code_ids` empty.
- **A code that does not exist on this send** (e.g. she writes `K99` and no
  such code was issued this trip) → react 😢 and reply *"Kode K99 nggak ada di
  trip ini kak 🙏"*. No `catalogue_requests` row is written — there is nothing
  to approve or reject, only a bad reference to point out.
- **Send belongs to a closed event** → reply *"trip sudah tutup"*, write the
  row as `rejected` so the owner can see she tried, react ❌.
- **She claims a code twice** → a second row, not an error. Two bags is a
  legitimate thing to ask for in two messages.

Word/name matching (both the exact-token and fuzzy-candidate cases above) is
scoped to products tagged on **currently open sends only** — never the whole
catalogue. `2099A1` matches because it is on a live send's tagged list, not
because it exists somewhere in 6 817 products.

**Unresolved identity differs from the shelf path, because of a real schema
difference.** `wa_claims.customer` is nullable — unresolved is a normal,
common state there. `catalogue_requests.customer_handle` is `NOT NULL`,
because it was designed for the catalogue-web path, where a handle is always
typed. A product-post claim from a number with no known IG handle writes
`customer_handle` as the raw sender number (already tolerated: the existing
comment on this column notes a request can be submitted before a `customers`
row exists at all) and corrects it in place once identity resolves —
`wa_identity_asks` still governs whether, and how often, the bot asks. This
keeps the "one row, updated in place" rule from the `asking` status above
rather than introducing a second, nullable identity concept just for this
path.

## The ❔ question

Every ❔ is asked in the group **and** waiting in the inbox at the same time.
Whichever side answers first settles it; the other becomes non-interactive.
The owner never has to be at their phone, and she never has to wait for a
reply that may not come until tomorrow. Four cases:

**A — one candidate.** The bot quotes her message and asks a yes/no
confirmation: *"Maksudnya K42 Boston Bag 38L Black — Rp 385.000 ya kak? 👍
kalau betul"*, recording that message's id as `bot_message_id`. Meanwhile the
row already shows in the inbox as *"Ditanya di grup — menunggu 👍"*, with the
one candidate pre-selected in a radio picker — picking it (or her 👍 arriving
first) resolves the row to `status = 'pending'`, setting `product_id` and
`send_code_id` from the candidate. Resolving is not approving: she confirmed
*which product*, not that it is bought. **Setuju** only appears, as a
separate later step, once the row has reached `pending` — exactly as for any
other row in this inbox.

**B — several candidates.** The bot lists only the codes, quoting her message:
*"Yang mana kak? K41 Greige · K42 Black — Balas kodenya ya 🙏"*. Never *"balas 1
atau 2"* — a bare number is exactly what a quantity reply looks like, and
would be indistinguishable from one. The inbox shows the same candidates as a
radio picker with **none pre-selected** — the bot has no opinion between two
equals, so neither does the row. A code reply resolves the same way a normal
code claim does; the reply is matched against `candidate_send_code_ids`, not
the whole send, so a code she types that wasn't among the options offered
does not silently resolve here.

**C — the owner answers first.** The confirmation/candidates question (case A
or B) is always posted **synchronously**, the moment the worker detects the
ambiguity — before an owner could plausibly react from the dashboard, which
has no socket of its own and reaches the group only through a queue the
worker drains on a timer (see "Delivering a dashboard action to the group"
below). So by the time the owner picks a candidate in the inbox, the question
is already sitting in the group; picking a candidate settles the row
immediately — no waiting on a 👍 that may come tomorrow — and queues exactly
**one** new message: the closing line, quoting her original text —
*"Sudah dicatat ya kak — K42 ×1 ✅"*. A 👍 arriving afterwards finds
`bot_message_id` already resolved (`status` no longer `asking`) and does
nothing — idempotent by construction, since it can only ever move a row that
is still `asking`.

**D — a reply to a closed trip's post.** She scrolls up and replies to last
trip's post; the bot replies *"Maaf kak, trip LSJP sudah tutup 🙏"* per the
closed-trip rule above, and the row is written `rejected`. The inbox shows it
greyed and inert — *"Trip sudah tutup — tidak dicatat"* — informational only,
never actionable. Codes restart every trip, so the current trip may have its
own `A21`; she quoted the old post, and a quote names its send.

## The inbox

Screen: the existing **Order Requests** (`app/dashboard/order-requests`) — one
list for both origins, not a second screen beside it. A `source` badge
(*Catalogue* / *WhatsApp*) distinguishes a row's origin; everything else about
the row — **Setuju**, **Tolak**, the qty/note/price it shows — is the same
code path regardless of where it came from.

Row: code (WhatsApp rows only) · handle · quantity · her words verbatim · the
resolved product and price.

- `asking` rows show *"Ditanya di grup — menunggu 👍"* (one candidate) or
  *"Ditanya di grup — N kemungkinan"* (several), with the radio picker from
  the ❔ section above. Picking a candidate is its own action, separate from
  **Setuju**/**Tolak** — it resolves the row (`product_id`/`send_code_id` set,
  `status → pending`), exactly what her 👍 or code reply would have done from
  the other side. **Setuju**/**Tolak** are not shown on an `asking` row at
  all; they appear once it has resolved to `pending`, same as any other row.
- `rejected` closed-trip rows (case D) are shown greyed and inert.
- `pending` rows behave exactly as a catalogue-web request already does.

**Setuju**, in one transaction — the existing `convertCatalogueRequest` path,
unchanged for a `catalogue`-source row, extended for `whatsapp`:

1. `appendOrders` with the row's event (from `wa_sends.event` for a WhatsApp
   row), customer, `product_id`, `unitPrice = wa_send_codes.price`,
   `unit = qty`, `note`.
2. Write `converted_order_id` back and set `status = 'converted'`.
3. For a WhatsApp row, queue a ✅ reaction on her message (`message_id`) via
   `wa_replies` — Setuju is a dashboard action, so it reaches the group
   through the same queue as everything else in "Delivering a dashboard
   action to the group" above, not a direct call.

Refused when the row has no resolvable customer, when its event is closed, or
when `converted_order_id` is already set — the existing guarded-`UPDATE`
race-protection (`FOR UPDATE` + re-checked `WHERE status = 'pending'`) covers
a `pending` WhatsApp row exactly as it already does a catalogue-web one; an
`asking` row is not eligible for Setuju until it has resolved to `pending`.

**Tolak** sets `rejected`, and for a WhatsApp row queues a ❌ reaction the
same way, so she is not left waiting on something that never existed.

From that point it is an ordinary order: it appears on the Shopping List, is
bought, dispatched and invoiced like anything typed on the Order page — the
same as it already does for a converted catalogue-web request today.

## What this does not touch

- **Group Order** lists shelves. Sends are reached from it but never appear in
  its shelf list, its tally, or its counts.
- **The public catalogue** (`catalogue_posts.visible`) is unaffected by
  whether a post has also been sent to WhatsApp — the two are independent
  destinations of the same post, and turning one on says nothing about the
  other.
- **The code never leaves the composer, the group, and the inbox.** Not the
  shopping list, not the packing list, not the invoice, not the product name.

## Testing

`node:test` + `tsx`, matching the existing suite.

- `codes.ts` — the alphabet excludes I/O/S and includes Q; `A99` rolls to `B01`;
  `nextCode` restarts at `A01` on a new event; `parseCodes` finds `K42` in
  "K42 mau 1", "mau K41 dua ya kak", and rejects "100" and "38L".
- Resolution — quoted send wins over the active event; unquoted resolves
  against the group's active event; a closed event refuses; two codes in one
  message raise the several-candidates path; an unrecognised code (e.g. `K99`
  on a send that never issued it) reacts 😢 and writes no row; a unique exact
  token from a tagged product's name (e.g. `2099A1`) resolves as a direct
  claim, not a candidate.
- The `asking` row — created with `product_id` null on first ambiguous reply;
  updated in place (never replaced) once resolved; `candidate_send_code_ids`
  constrains what a code reply or inbox pick can resolve to.
- The ❔ dual channel — 👍 settles a one-candidate row and sets `pending`; a
  code reply settles a multi-candidate row; an owner pick in the inbox closes
  the row and posts both bot messages to the group; a 👍 arriving after that
  finds the row already resolved and does nothing (idempotent); two 👍 in a
  row are idempotent for the same reason.
- Approval — writes exactly one order at the snapshot price; a second Setuju
  is refused; a row with no resolvable customer is refused; an `asking` row is
  refused until it resolves to `pending`.
- Repost — codes continue the destination trip's own sequence rather than
  restarting; a product no longer tagged to the post is skipped and struck
  through, not blocking; a price that moved since the last send is shown as a
  diff, not silently applied.
- Quantity — reuses the existing `parseQuantity` tests; no new parser.

## Open questions

Flagged rather than silently decided — neither has a design yet:

- **A tagged product is renamed while a send referencing it is still open.**
  The caption already printed the old name in the group; the composer and
  inbox would start showing the new one. No resolution proposed here.
- **Manual/DM entry of a claim against a send**, as opposed to a shelf/SKU
  claim — which already has a designed manual-entry UI (`manualclaim.html`,
  from the shelf-capture work) that does not directly transfer, since a send
  has no slots to pick from, only tagged products and codes.

## Out of scope

- Editing a send after it has been posted.
- Stock limits per line ("ready 3 only") and any waiting list.
- Sends in the public catalogue view (`catalogue_posts.visible` already
  covers "is this post shown on the customer site" independently of sending).
- Claims by DM against a send — the DM paths already built cover shelves only,
  and mixing the two is the open question above, not a decision made here.
