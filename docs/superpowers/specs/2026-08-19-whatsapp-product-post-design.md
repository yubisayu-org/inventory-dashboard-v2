# WhatsApp Product Posts — Design

**Date:** 2026-08-19
**Branch:** `feat/whatsapp-product-post`
**Status:** approved in brainstorming, not yet planned

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

## Data model — migration 075

Separate tables rather than a `kind` column on `wa_posts`.

`wa_posts` is read in 38 places: the public catalogue, the archive sweep, the
rekap renderer, the shop list, tally, naming, pricing. A `kind` column makes
every one of those a filter that can be forgotten, and the cost of forgetting
one is a product post appearing on the customer-facing catalogue page. The
lifecycles have almost nothing in common either — no clustering, no slots, no
naming, no tally — so the shared columns would be `event` and `image_path`.

```sql
-- A photo of products that already exist, posted to the group for claims.
CREATE TABLE wa_product_posts (
  id           SERIAL PRIMARY KEY,
  event        TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE,
  image_path   TEXT NOT NULL,
  image_width  INTEGER NOT NULL DEFAULT 0,
  image_height INTEGER NOT NULL DEFAULT 0,
  -- The caption's first line. Free text: "MUJI restock", "Ready stock hari ini".
  title        TEXT NOT NULL DEFAULT '',
  -- Set once the bot has posted it. A reply quoting this resolves here.
  message_id   TEXT NOT NULL DEFAULT '',
  group_jid    TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ
);

CREATE INDEX idx_wa_product_posts_event ON wa_product_posts (event);
CREATE INDEX idx_wa_product_posts_message
  ON wa_product_posts (message_id) WHERE message_id <> '';

-- One line of a post: a product, under a code, at the price it was posted at.
CREATE TABLE wa_product_items (
  id         SERIAL PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES wa_product_posts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  code       TEXT NOT NULL,
  -- The price printed in the caption. Snapshot, not a live read: the group was
  -- quoted this number, and repricing the product tomorrow must not silently
  -- change what a customer agreed to yesterday.
  price      NUMERIC(14,2) NOT NULL,
  -- Where the code was pinned on the photo, normalized 0..1. Null when the
  -- owner did not pin it — a caption line is enough for most posts.
  point_x    DOUBLE PRECISION,
  point_y    DOUBLE PRECISION,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wa_product_items_post ON wa_product_items (post_id);

-- A code is unique within a trip, which is what makes an unquoted "K42 mau 1"
-- resolvable. Enforced against the post's event via a trigger-free join table
-- would be neater; a redundant event column is simpler and cheaper to check.
ALTER TABLE wa_product_items ADD COLUMN event TEXT NOT NULL
  REFERENCES events(name) ON UPDATE CASCADE;
CREATE UNIQUE INDEX idx_wa_product_items_code ON wa_product_items (event, code);

-- One customer's reply, resolved to a line or waiting to be.
CREATE TABLE wa_product_claims (
  id         SERIAL PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES wa_product_posts(id) ON DELETE CASCADE,
  -- Null while the bot cannot tell which line she meant.
  item_id    INTEGER REFERENCES wa_product_items(id) ON DELETE CASCADE,
  sender     TEXT NOT NULL DEFAULT '',
  customer   TEXT REFERENCES customers(instagram_id) ON UPDATE CASCADE,
  quantity   INTEGER NOT NULL DEFAULT 1,
  -- Her words, verbatim. What the inbox shows and what lands on the order.
  note       TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT 'pending',
  -- Set on approval, so an order is never written twice for one claim.
  order_id   INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  message_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

-- pending  — resolved to a line, waiting on the owner
-- asking   — the bot could not tell which line and has asked in the group
-- approved — an order exists
-- rejected — the owner discarded it, or the trip was already closed
ALTER TABLE wa_product_claims ADD CONSTRAINT wa_product_claims_state_check
  CHECK (state IN ('pending', 'asking', 'approved', 'rejected'));

CREATE INDEX idx_wa_product_claims_post ON wa_product_claims (post_id);
CREATE INDEX idx_wa_product_claims_open
  ON wa_product_claims (id) WHERE state IN ('pending', 'asking');

-- The bot's "which one did you mean?", waiting on an answer. Mirrors
-- wa_size_offers (migration 069), for the same reason: a reaction or a reply
-- arrives with nothing but a message id, and this is what ties it to a claim.
CREATE TABLE wa_code_offers (
  id          SERIAL PRIMARY KEY,
  claim_id    INTEGER NOT NULL REFERENCES wa_product_claims(id) ON DELETE CASCADE,
  -- The lines offered, in caption order. One entry means a 👍 question; two or
  -- more means she was asked to reply with a code.
  item_ids    INTEGER[] NOT NULL,
  group_jid   TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ,
  -- Which line settled it, however it was settled. Null with answered_at set
  -- means she declined.
  item_id     INTEGER REFERENCES wa_product_items(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_wa_code_offers_message
  ON wa_code_offers (group_jid, message_id);
CREATE INDEX idx_wa_code_offers_claim ON wa_code_offers (claim_id);
```

### Outbox

`wa_outbox.post_id` is `NOT NULL REFERENCES wa_posts(id)`. Migration 075 makes
it nullable, adds `product_post_id`, and requires exactly one:

```sql
ALTER TABLE wa_outbox ALTER COLUMN post_id DROP NOT NULL;
ALTER TABLE wa_outbox ADD COLUMN product_post_id INTEGER
  REFERENCES wa_product_posts(id) ON DELETE CASCADE;
ALTER TABLE wa_outbox ADD CONSTRAINT wa_outbox_one_target
  CHECK ((post_id IS NULL) <> (product_post_id IS NULL));
-- The caption to send. Empty for a shelf, whose caption the worker renders.
ALTER TABLE wa_outbox ADD COLUMN caption TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_wa_outbox_product_post
  ON wa_outbox (product_post_id) WHERE product_post_id IS NOT NULL;
```

## Modules

| File | Responsibility |
|---|---|
| `lib/whatsapp/codes.ts` | The alphabet, `nextCode(event)`, `parseCodes(text)` |
| `lib/db/product-posts.ts` | Post/item/claim reads and writes |
| `lib/whatsapp/product-post.ts` | Compose a post: attach items, issue codes, build the caption, queue the send |
| `lib/whatsapp/product-claim.ts` | Resolve an incoming message to an item; approve; reject |
| `lib/whatsapp/code-offer.ts` | Ask, and settle from either side |
| `app/dashboard/shop/product-post/` | Composer screen |
| `app/dashboard/shop/inbox/` | Claim inbox |
| `app/api/whatsapp/product-posts/…` | Composer and inbox routes |

`lib/whatsapp/codes.ts`:

```ts
/** Letters a code can start with. I, O and S are dropped: they read as 1, 0, 5. */
export const CODE_LETTERS = "ABCDEFGHJKLMNPQRTUVWXYZ"
```

## Composing a post

Screen: **Group Order → + Product post**.

1. Upload one photo. Stored full-resolution through the existing `storeShelf`
   path (3 000 px, quality 70) so the group gets a sharp picture.
2. Search the catalogue. **Server-side**, `LIMIT 20`, matching name and store —
   6 817 products cannot go in a dropdown. Reuses the existing product search
   route where its shape allows.
3. Each attached product takes the next free code for the trip and snapshots its
   current price.
4. Optionally drag a code onto the photo, which stores `point_x/point_y`. The
   pin is drawn into the sent image; the stored original keeps no pin.
5. **Kirim ke grup** writes the caption into `wa_outbox` and returns. The worker
   posts it and writes the `message_id` back, exactly as it does for shelves.

A post cannot be edited after it is sent — the group already has the caption.
Deleting one before it sends cancels the outbox row.

## Resolving a reply

In the worker, before shelf handling (a product post is text-only, so nothing
here touches clustering):

1. **Quoted a product post** → that post, and its event.
2. **Not quoted** → if the group's active event has any open product post,
   scan the text for a code belonging to that event.
3. Neither → not a product claim; fall through to the existing shelf path.

Then, on the resolved post:

- **Exactly one code found** → claim on that item. Quantity from the existing
  `parseQuantity`. React 📝. State `pending`.
- **No code, but the text names exactly one item** (product name or a distinctive
  word from it, case-insensitive, and unique among that post's items) → open an
  offer with one candidate. React ❔. State `asking`.
- **No code, several candidates** → offer with all of them. React ❔.
  State `asking`.
- **No code, no candidate** → react ❔ with a plain "kodenya yang mana kak?".
  State `asking`, no candidates.
- **Post belongs to a closed event** → reply *"trip sudah tutup"*, write the
  claim as `rejected` so the owner can see she tried, react ❌.
- **She claims a code twice** → a second claim row, not an error. Two bags is a
  legitimate thing to ask for in two messages.

Unknown senders keep the existing behaviour: the claim is written with a null
customer, and `wa_identity_asks` governs whether the bot asks who they are.

## The ❔ question

The bot asks in the group **and** the row appears in the inbox. Whichever side
answers first settles it; the other goes read-only.

- **One candidate** — *"Maksudnya K42 Boston Bag 38L Black — Rp 385.000 ya kak?
  👍 kalau betul"*. Her 👍 sets `item_id` and moves the claim to `pending`.
- **Two or more** — the bot lists only the codes. Never "balas 1 atau 2": a bare
  number is exactly what a quantity looks like.
- **The owner answers first** — picking in the inbox settles the claim and the
  bot posts *"sudah dicatat ya kak — K42 ×1 ✅"* under her message, so she is not
  left answering a dead question. A 👍 arriving afterwards finds
  `answered_at` set and does nothing.

Her answer says **which product**, never that it is bought. The claim still
needs the owner's approval — the two are different questions.

## The inbox

Screen: **Group Order → Masuk**, one row per open claim.

Row: code · handle · quantity · her words verbatim · the resolved product and
price. **Setuju** and **Tolak**.

- `asking` rows show *Ditanya di grup* and a radio picker of the candidates.
  One candidate is pre-selected; two or more are not, because the bot has no
  opinion between equals.
- `rejected` closed-trip rows are shown greyed and inert.

**Setuju**, in one transaction:

1. `appendOrders` with the claim's event, customer, `product_id`,
   `unitPrice = wa_product_items.price`, `unit = quantity`, `note`.
2. Write `order_id` back on the claim and set `state = 'approved'`.
3. React ✅ on her message.

Refused when the claim has no customer (nobody to invoice), when its event is
closed, or when `order_id` is already set.

**Tolak** sets `rejected` and reacts ❌, so she is not left waiting on something
that never existed.

From that point it is an ordinary order: it appears on the Shopping List, is
bought, dispatched and invoiced like anything typed on the Order page.

## What this does not touch

- **Group Order** lists shelves. Product posts are reached from it but never
  appear in its shelf list, its tally, or its counts.
- **The public catalogue** shows shelves only. `archiveEvent` does not sweep
  product-post images — they are pictures of catalogue products and the
  catalogue already has its own.
- **The code never leaves the composer, the group, and the inbox.** Not the
  shopping list, not the packing list, not the invoice, not the product name.

## Testing

`node:test` + `tsx`, matching the existing suite.

- `codes.ts` — the alphabet excludes I/O/S and includes Q; `A99` rolls to `B01`;
  `nextCode` restarts at `A01` on a new event; `parseCodes` finds `K42` in
  "K42 mau 1", "mau K41 dua ya kak", and rejects "100" and "38L".
- Resolution — quoted post wins over the active event; unquoted resolves against
  the group's active event; a closed event refuses; two codes in one message
  raise the several-candidates path.
- Offers — 👍 settles a one-candidate offer; a code reply settles a multi; an
  owner answer closes the offer and a later 👍 is inert; two 👍 are idempotent.
- Approval — writes exactly one order at the snapshot price; a second Setuju is
  refused; a claim with no customer is refused.
- Quantity — reuses the existing `parseQuantity` tests; no new parser.

## Out of scope

- Editing a post after it has been sent.
- Stock limits per line ("ready 3 only") and any waiting list.
- Product posts in the public catalogue.
- Claims by DM against a product post — the DM paths already built cover shelves
  only, and mixing the two is its own design.
