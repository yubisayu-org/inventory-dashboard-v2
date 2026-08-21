-- Which sites usually get quoted in Tier Kurs vs Profit Margin, so
-- "Propose a price revision" can pre-select the right tab from a URL in the
-- request's own description/note instead of always defaulting to Profit
-- Margin. One domain per line — editable from Settings, not a code change.
ALTER TABLE product_defaults
  ADD COLUMN tier_kurs_sites text NOT NULL DEFAULT '24028-net.jp
zara.com';
