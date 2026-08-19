-- WhatsApp product posts: claim an already-catalogued product by a short
-- code (or, for a product whose name already starts with a store code, by
-- that code directly). Builds on catalogue_posts/catalogue_requests
-- (migration 058, extended by 076/079) instead of duplicating them — see
-- docs/superpowers/specs/2026-08-19-whatsapp-product-post-design.md.

-- One trip a catalogue post is sent to. A repost of the same post to a
-- later trip is a second row here, not a new catalogue_posts row.
CREATE TABLE wa_sends (
  id         SERIAL PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES catalogue_posts(id) ON DELETE CASCADE,
  event      TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  group_jid  TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX idx_wa_sends_post ON wa_sends (post_id);
CREATE INDEX idx_wa_sends_event ON wa_sends (event);
CREATE INDEX idx_wa_sends_message ON wa_sends (message_id) WHERE message_id <> '';

-- One coded line of a send: a tagged product, its code, and the price it
-- was posted at.
CREATE TABLE wa_send_codes (
  id         SERIAL PRIMARY KEY,
  send_id    INTEGER NOT NULL REFERENCES wa_sends(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  code       TEXT NOT NULL,
  event      TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE,
  price      NUMERIC(14,2) NOT NULL,
  point_x    DOUBLE PRECISION,
  point_y    DOUBLE PRECISION,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wa_send_codes_send ON wa_send_codes (send_id);
CREATE UNIQUE INDEX idx_wa_send_codes_code ON wa_send_codes (event, code);

-- What a dashboard action needs the worker to say or react in the group —
-- Setuju/Tolak reactions, and the ❔ closing line when the owner resolves an
-- asking row first. The dashboard has no socket; the worker drains this on
-- a timer, the same shape as wa_outbox.
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

-- catalogue_requests becomes the one inbox for both a public-catalogue
-- request and a WhatsApp claim. product_id is ALREADY nullable and status
-- ALREADY carries offer_pending/approved (076_custom_catalogue_requests.sql,
-- 079_custom_request_edit_approval.sql) — this extends that real shape,
-- confirmed against the local dev DB, not the branch's original base shape.
ALTER TABLE catalogue_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'catalogue'
  CHECK (source IN ('catalogue', 'whatsapp'));

ALTER TABLE catalogue_requests ADD COLUMN send_id INTEGER
  REFERENCES wa_sends(id) ON DELETE CASCADE;
ALTER TABLE catalogue_requests ADD COLUMN send_code_id INTEGER
  REFERENCES wa_send_codes(id) ON DELETE SET NULL;
ALTER TABLE catalogue_requests ADD COLUMN sender TEXT NOT NULL DEFAULT '';
ALTER TABLE catalogue_requests ADD COLUMN message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE catalogue_requests ADD COLUMN bot_message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE catalogue_requests ADD COLUMN candidate_send_code_ids INTEGER[];

ALTER TABLE catalogue_requests DROP CONSTRAINT catalogue_requests_status_check;
ALTER TABLE catalogue_requests ADD CONSTRAINT catalogue_requests_status_check
  CHECK (status IN ('pending', 'offer_pending', 'approved', 'asking', 'converted', 'rejected'));

ALTER TABLE catalogue_requests DROP CONSTRAINT catalogue_requests_product_or_description;
ALTER TABLE catalogue_requests ADD CONSTRAINT catalogue_requests_product_or_description
  CHECK (product_id IS NOT NULL OR description <> '' OR status = 'asking');

CREATE INDEX idx_catalogue_requests_send ON catalogue_requests (send_id);
CREATE INDEX idx_catalogue_requests_asking
  ON catalogue_requests (id) WHERE status = 'asking';

-- wa_outbox: a send's photo+caption reuses the shelf queue, not a new table.
ALTER TABLE wa_outbox ALTER COLUMN post_id DROP NOT NULL;
ALTER TABLE wa_outbox ADD COLUMN send_id INTEGER
  REFERENCES wa_sends(id) ON DELETE CASCADE;
ALTER TABLE wa_outbox ADD CONSTRAINT wa_outbox_one_target
  CHECK ((post_id IS NULL) <> (send_id IS NULL));
ALTER TABLE wa_outbox ADD COLUMN caption TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_wa_outbox_send
  ON wa_outbox (send_id) WHERE send_id IS NOT NULL;
