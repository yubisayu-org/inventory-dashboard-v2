-- Her street and her province, as fields rather than prose.
--
-- Both have always been collected: the registration form asks for `jalan` and
-- `provinsi`, composes them into the one free-text blob the shipping label
-- prints, and stores neither. So the street could only be corrected by editing
-- a paragraph, and the province existed nowhere the shop could read.
--
-- With these two, every part of an address is a field of its own, and the blob
-- becomes what it should have been all along: the label, generated from the
-- parts, rather than a place where six things are typed together and one of
-- them is silently different from the column beside it.
--
-- `jalan` holds newlines on purpose. A street is often three lines --
-- "Memora House / Cluster Milestone F09 / Jl. Bambu Apus" is one address, and
-- a hundred of them in production look like that.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS jalan    TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS provinsi TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN customers.jalan IS
  'Street address, newlines kept — printed on the label as typed.';
COMMENT ON COLUMN customers.provinsi IS
  'Province, for the label. The courier prices by kecamatan/kota, not by this.';
