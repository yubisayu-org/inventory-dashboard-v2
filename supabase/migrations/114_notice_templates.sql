-- The wording of an inbox notice, editable by the owner.
--
-- Sibling of message_templates (040), with one more column: an inbox item has
-- a title and a WhatsApp message does not.
--
-- Nothing is seeded. lib/notice-templates.ts still holds the house wording,
-- and getNoticeTemplates falls back to it per key — so an absent row, a blank
-- body, or a table that has not been migrated yet all produce the same notice
-- the code has always sent. That was the original reason this wording lived
-- outside the database, and it survives the move: a mangled row can change how
-- a notice reads, never whether it goes.
--
-- Re-running is safe.

CREATE TABLE IF NOT EXISTS notice_templates (
  key        TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Same idiom as 040_settings.sql: app_runtime already has DML on new public
-- tables via 019's ALTER DEFAULT PRIVILEGES, so only the audit trigger is new.
DROP TRIGGER IF EXISTS audit_notice_templates ON notice_templates;
CREATE TRIGGER audit_notice_templates
AFTER INSERT OR UPDATE OR DELETE ON notice_templates
FOR EACH ROW EXECUTE FUNCTION audit.log_change();
