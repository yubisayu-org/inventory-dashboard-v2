-- A public bucket, holding only the catalogue copies.
--
-- Separate from wa-posts, which is private and stays private: that one holds the
-- full-size originals, and an annotated shelf shows who wants what. This one
-- holds a downscaled AVIF of the same rack and nothing else — no prices, no
-- names, no marks — which is what a customer is shown anyway.
--
-- Public rather than signed because caching is what keeps the egress small: a
-- signed URL rotates, so every rotation is a fresh download of a file that never
-- changes. Object names are the WhatsApp message id, twenty-odd random
-- characters, so a URL cannot be guessed — only shared.
INSERT INTO storage.buckets (id, name, public)
VALUES ('wa-catalogue', 'wa-catalogue', true)
ON CONFLICT (id) DO UPDATE SET public = true;
