# Catalogue Highlights — Design

**Goal:** let the owner group catalogue posts into named "highlights"
(Instagram-Highlights-style collections), customer-browsable on the
video-catalog site, each with a default purchasing event — so that when a
request originating from a highlighted post gets converted, the event
picker is already filled in instead of the owner picking it manually every
time.

**Relationship to prior work:** builds on the already-shipped catalogue
posts/requests feature (`catalogue_posts`, `catalogue_post_products`,
`catalogue_requests`) in the dashboard repo, and the story-mode UI already
shipped in the video-catalog repo. Reuses the existing `events` table
as-is (no changes to it) — a highlight merely references an event by name,
the same way any other transactional table already does.

## Context established during design

- `events` represents a purchasing/restocking trip/batch (per-country, per
  warehouse), not a live-selling session — multiple events can be active
  concurrently, and every order's event is picked independently per-order.
  A highlight's `default_event` is exactly that: a default for the picker,
  never a hard link.
- `catalogue_posts` has no grouping concept today. `catalogue_requests` has
  no reference back to the post that prompted it at all — not even for the
  "Fix" flow (tap a tagged product on a story slide), where the client
  already has the post id in hand but currently drops it before sending.
  Closing that gap is part of this spec, not a separate follow-up.

## Data Model

New table `catalogue_highlights`:

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL PRIMARY KEY` | |
| `name` | `TEXT NOT NULL` | Customer-visible label |
| `default_event` | `TEXT REFERENCES events(name)` | Nullable — a highlight may have no default |
| `sort_order` | `INTEGER NOT NULL DEFAULT 0` | Order in the customer-facing highlight picker |
| `visible` | `BOOLEAN NOT NULL DEFAULT true` | Soft-hide, same convention as `catalogue_posts.visible` |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | |

Cover image: no new upload flow. A highlight's cover is implicitly whichever
of its assigned posts has the earliest `created_at` — reuses existing post
media, no new storage/upload path.

`catalogue_posts` gains a nullable `highlight_id INTEGER REFERENCES catalogue_highlights(id) ON DELETE SET NULL` — one highlight per post (not many-to-many), a straightforward reassignable column, no join table.

`catalogue_requests` gains a nullable `post_id INTEGER REFERENCES catalogue_posts(id) ON DELETE SET NULL`. Populated only for "Fix" requests (tagged-product requests originating from a specific post); custom (free-text) requests never have a post of origin and always leave this `NULL` — no event-prefill applies to them, by design, not by gap.

## Plumbing fix (prerequisite, bundled into this spec)

The video-catalog site's "Fix" flow already tracks `postId` client-side
(`app.js`'s `activeFix = {postId, productId}`) but the POST to
`/api/catalogue-requests` never includes it, and the dashboard's
`/api/public/catalogue/requests` route doesn't accept it. Both need to
carry `postId` through so it lands in `catalogue_requests.post_id`. This is
a bug-fix-shaped prerequisite for the rest of this feature, not new
product surface.

## Dashboard Management

No new page. Folded into the existing Catalogue Posts page
(`app/dashboard/catalogue-posts/CataloguePostsClient.tsx`):

- A row of highlight chips above the posts table — each chip opens an
  inline create/edit affordance (name, default event picker sourced from
  `activeEvents`, sort order, visible toggle), plus a "+ New" chip. Delete
  is soft (`visible = false`), matching `catalogue_posts`'s own convention
  — never hard-deleted while posts might still reference it (the FK's
  `ON DELETE SET NULL` covers the edge case regardless).
- Each row in the existing posts table gains a highlight-assignment
  dropdown (assign/reassign/unassign), next to the existing caption/visible
  controls.

## Customer Experience

A third icon in the existing story topbar (alongside today's ➕ "Request
khusus" and 🧾 "Cek status permintaan"), opening a picker sheet — reusing
the exact sheet pattern already in the codebase (`fixSheet`/`statusSheet`
in `index.html`), not a new UI paradigm. The sheet lists visible highlights
(ordered by `sort_order`) plus a "Semua Post" (all posts) entry. Selecting
a highlight filters the story feed to just that highlight's posts;
selecting "Semua Post" returns to today's unfiltered default. The default
landing experience (opening the site drops straight into the unfiltered
story feed) is unchanged — highlights are opt-in via the new icon, not a
new mandatory landing screen.

New public API: `GET /api/public/catalogue/highlights` → `{highlights:
[{id, name}]}` (visible only, ordered by `sort_order`, ties broken by
`id`); existing `GET /api/public/catalogue` gains an optional
`?highlightId=` filter. Both follow the same public-route conventions as
every other route in this feature family (fixed `ALLOWED_ORIGIN` CORS,
no auth) — read-only, no oracle/rate-limit concern since nothing secret or
computed is being returned.

## Event-Prefill Mechanics

When the owner opens Convert on a request whose `post_id` resolves through
`catalogue_posts.highlight_id` to a `catalogue_highlights.default_event`
that is currently in `activeEvents`, the Convert modal's event picker
pre-selects that value. The owner can still change it — this is a default,
not an enforced link. If any part of the chain is missing (no `post_id`,
post has no highlight, highlight has no default event, or that event is no
longer active), the picker behaves exactly as it does today: blank, owner
picks manually. No error state, no surprising a stale/deactivated event
into a conversion.

## Non-Goals

- No many-to-many post-to-highlight relationship — one highlight per post,
  by explicit choice during design; a join table can be added later if this
  turns out to be too limiting.
- No explicit cover-image upload for a highlight — it's implicitly the
  earliest-created assigned post's media.
- No event-prefill for custom (free-text) requests — they have no post of
  origin, so there's nothing to derive a default event from. The separate
  custom-request edit/approval feature (see
  `2026-08-17-custom-request-edit-approval-design.md`) is unrelated to this
  one and unaffected by it.
- No changes to the `events` table itself — highlights only reference it by
  name, exactly like every other existing table that has an `event` column.
- No customer-facing landing page — the story feed's default (unfiltered,
  opens immediately) is unchanged; highlights are reached only via the new
  topbar icon.
