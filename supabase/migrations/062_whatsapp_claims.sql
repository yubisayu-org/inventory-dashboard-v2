-- Claim capture from WhatsApp groups.
--
-- Three tables, in the order a claim travels: a POST is an image the owner sent
-- to a group; a CLAIM is one customer's reply resolved to a position or a
-- variant; a SLOT is the group of claims that mean the same item.
--
-- Slots are derived, not authored: clustering recomputes them from claims. They
-- carry the two things that are NOT derivable — how many were bought, and which
-- product they turned out to be once named.

CREATE TABLE wa_posts (
  id            SERIAL PRIMARY KEY,
  event         TEXT NOT NULL REFERENCES events(name) ON UPDATE CASCADE,
  -- Object path in the posts bucket. The image itself never lives in Postgres.
  image_path    TEXT NOT NULL,
  image_width   INTEGER NOT NULL DEFAULT 0,
  image_height  INTEGER NOT NULL DEFAULT 0,
  -- Everything a named slot inherits, so naming asks only for name/valas/gram.
  store         TEXT NOT NULL DEFAULT '',
  country_id    INTEGER REFERENCES countries(id) ON DELETE RESTRICT,
  pricing_method TEXT NOT NULL DEFAULT 'overseas',
  -- Free text listing variants ("warna: hitam/merah\nsize: 38-42"). Empty for a
  -- shelf photo, which has no declared variants — its slots are discovered.
  note          TEXT NOT NULL DEFAULT '',
  -- Hues (degrees) that are safe to read as pen ink on THIS photo, computed
  -- from its own histogram at post time. Stored rather than recomputed so every
  -- reply is resolved against the same answer.
  safe_hues     INTEGER[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ
);

CREATE INDEX idx_wa_posts_event ON wa_posts (event);

ALTER TABLE wa_posts DROP CONSTRAINT IF EXISTS wa_posts_pricing_method_check;
ALTER TABLE wa_posts ADD CONSTRAINT wa_posts_pricing_method_check
  CHECK (pricing_method IN ('overseas', 'tier_fee', 'flat_fee', 'tier_kurs', 'flat_kurs', 'target_price'));

CREATE TABLE wa_claims (
  id            SERIAL PRIMARY KEY,
  post_id       INTEGER NOT NULL REFERENCES wa_posts(id) ON DELETE CASCADE,
  -- The sender's WhatsApp number, digits only. Kept even after the customer is
  -- resolved, because that resolution can be corrected later.
  sender        TEXT NOT NULL DEFAULT '',
  -- Bare lowercase IG handle once known. Null means unresolved, which is a
  -- review state rather than an error.
  customer      TEXT REFERENCES customers(instagram_id) ON UPDATE CASCADE,
  source        TEXT NOT NULL,
  -- Normalized 0..1. Null for a variant claim, which has no position.
  point_x       DOUBLE PRECISION,
  point_y       DOUBLE PRECISION,
  -- Variant id from parseVariantNote, e.g. "hitam|38". Null for a shelf claim.
  variant_id    TEXT,
  quantity      INTEGER NOT NULL DEFAULT 1,
  -- A size or colour the customer asked for that the photo cannot express.
  -- Raw and unparsed: a shelf has no variant list to resolve it against.
  note          TEXT NOT NULL DEFAULT '',
  -- Resolver confidence, 0..1. Low values are what route a claim to review.
  confidence    DOUBLE PRECISION NOT NULL DEFAULT 1,
  state         TEXT NOT NULL DEFAULT 'pending',
  -- WhatsApp message id, so the reaction on it can be updated later.
  message_id    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ
);

CREATE INDEX idx_wa_claims_post ON wa_claims (post_id);
CREATE INDEX idx_wa_claims_state ON wa_claims (state);

ALTER TABLE wa_claims DROP CONSTRAINT IF EXISTS wa_claims_source_check;
ALTER TABLE wa_claims ADD CONSTRAINT wa_claims_source_check
  CHECK (source IN ('ink', 'crop', 'repost', 'text', 'manual'));

-- pending  — captured, not yet part of a slot
-- assigned — belongs to a slot
-- review   — needs a human: unresolved position, unknown sender, unclear text
-- rejected — the owner discarded it
ALTER TABLE wa_claims DROP CONSTRAINT IF EXISTS wa_claims_state_check;
ALTER TABLE wa_claims ADD CONSTRAINT wa_claims_state_check
  CHECK (state IN ('pending', 'assigned', 'review', 'rejected'));

CREATE TABLE wa_slots (
  id            SERIAL PRIMARY KEY,
  post_id       INTEGER NOT NULL REFERENCES wa_posts(id) ON DELETE CASCADE,
  -- Cluster centre for a shelf slot; null for a variant slot.
  point_x       DOUBLE PRECISION,
  point_y       DOUBLE PRECISION,
  variant_id    TEXT,
  -- How many were actually obtained. Independent of orders on purpose: the
  -- owner tallies in the shop, and naming may not have happened yet.
  bought        INTEGER NOT NULL DEFAULT 0,
  -- Set once the slot is named. Null means "nobody has said what this is".
  product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ
);

CREATE INDEX idx_wa_slots_post ON wa_slots (post_id);

ALTER TABLE wa_claims ADD COLUMN IF NOT EXISTS slot_id INTEGER
  REFERENCES wa_slots(id) ON DELETE SET NULL;
CREATE INDEX idx_wa_claims_slot ON wa_claims (slot_id);

-- Which pricing method a NEW WhatsApp post starts on.
--
-- Deliberately separate from default_pricing_method (migration 055), which
-- decides the Add Product form's opening tab: the owner wants these to differ,
-- and sharing one column would make changing either change both.
ALTER TABLE product_defaults
  ADD COLUMN IF NOT EXISTS whatsapp_pricing_method TEXT NOT NULL DEFAULT 'overseas';

ALTER TABLE product_defaults DROP CONSTRAINT IF EXISTS product_defaults_whatsapp_pricing_method_check;
ALTER TABLE product_defaults ADD CONSTRAINT product_defaults_whatsapp_pricing_method_check
  CHECK (whatsapp_pricing_method IN ('overseas', 'tier_fee', 'flat_fee', 'tier_kurs', 'flat_kurs', 'target_price'));
