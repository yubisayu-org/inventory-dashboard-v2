-- Which groups the bot is in, who may command it, and when it is collecting.

CREATE TABLE IF NOT EXISTS wa_groups (
  -- The WhatsApp group JID (…@g.us). Stable; the group's NAME is not, which is
  -- why the name below is only a cache.
  jid           TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  -- Which trip this group's claims belong to. Null until someone connects it.
  -- Groups outlive events and are re-bound rather than recreated.
  event         TEXT REFERENCES events(name) ON UPDATE CASCADE ON DELETE SET NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  name_checked_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ
);

-- Numbers allowed to command the bot.
--
-- The app's own roles key on email (lib/roles.ts), and a WhatsApp sender has a
-- number and no login, so this cannot reuse that check. It mirrors the same two
-- tiers: anyone here may pull the shopping list, and can_connect marks the one
-- person who may bind a group to an event, because that decides where every
-- claim for a trip lands.
CREATE TABLE IF NOT EXISTS wa_admins (
  -- Digits only, country code included, no plus. Normalize before writing.
  number        TEXT PRIMARY KEY,
  label         TEXT NOT NULL DEFAULT '',
  can_connect   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A capture window: while one is open, images the owner posts to that group
-- become posts, and outside it they are ordinary chat.
--
-- This exists so nothing has to be typed per photo. The window also carries the
-- store, which is the one field a post cannot derive from the event or the
-- settings — so it is stated once per shop rather than once per item.
CREATE TABLE IF NOT EXISTS wa_captures (
  id            SERIAL PRIMARY KEY,
  group_jid     TEXT NOT NULL REFERENCES wa_groups(jid) ON DELETE CASCADE,
  store         TEXT NOT NULL DEFAULT '',
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Null while open. Closed by command, or by the worker after a quiet spell, so
  -- that forgetting the command does not turn tomorrow's chat into posts.
  closed_at     TIMESTAMPTZ
);

-- At most one window open per group. A partial unique index says exactly that,
-- where a plain one would forbid a group ever having two closed windows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_captures_open
  ON wa_captures (group_jid) WHERE closed_at IS NULL;
