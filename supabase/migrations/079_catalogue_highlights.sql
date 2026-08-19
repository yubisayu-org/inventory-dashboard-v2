-- Catalogue Highlights (see
-- docs/superpowers/specs/2026-08-17-catalogue-highlights-design.md).
-- Owner groups catalogue posts into named highlights, each with an
-- optional default purchasing event, so converting a request that
-- originated from a highlighted post pre-fills the event picker instead
-- of a manual pick every time. One highlight per post (nullable FK, no
-- join table) — an explicit design choice.
--
-- Also adds catalogue_requests.post_id: the missing link needed to trace
-- a request back to its originating post. The video-catalog site's "Fix"
-- flow already has this id client-side but never sent it — closing that
-- gap is part of this migration's reason for existing, not a separate
-- concern.

CREATE TABLE catalogue_highlights (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  default_event TEXT REFERENCES events(name),
  sort_order INTEGER NOT NULL DEFAULT 0,
  visible BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

ALTER TABLE catalogue_posts
  ADD COLUMN highlight_id INTEGER REFERENCES catalogue_highlights(id) ON DELETE SET NULL;

ALTER TABLE catalogue_requests
  ADD COLUMN post_id INTEGER REFERENCES catalogue_posts(id) ON DELETE SET NULL;

-- catalogue_public already has whole-table SELECT on catalogue_posts
-- (migration 059) — highlight_id is included automatically, no new grant
-- needed there. catalogue_highlights needs its own, narrower grant:
-- id/name/visible/sort_order only. NEVER default_event — that's
-- staff-only purchasing information with no reason to ever reach the
-- public site.
GRANT SELECT (id, name, visible, sort_order) ON catalogue_highlights TO catalogue_public;

-- Additive: post_id joins the existing INSERT column list (migration 075)
-- for the Fix-flow submission path. No public SELECT grant on
-- catalogue_requests.post_id — nothing on the public read path needs it
-- (only the owner-side event-prefill query, which runs as the
-- unrestricted app role, reads it).
GRANT INSERT (post_id) ON catalogue_requests TO catalogue_public;

-- Explicit, idempotent grant for catalogue_posts.highlight_id, even though
-- 059's table-wide GRANT SELECT ON catalogue_posts already covers it today.
-- getVisibleCataloguePosts (the public posts feed) now hard-references
-- p.highlight_id, so if that table-wide grant ever narrows to a column
-- list, the whole public catalogue feed would 500 instead of just this
-- column being missing. Migration 061's comment documents this exact class
-- of grant drift happening before in this series — don't repeat it here.
GRANT SELECT (highlight_id) ON catalogue_posts TO catalogue_public;
