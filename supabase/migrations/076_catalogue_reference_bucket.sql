-- Separate bucket for anonymous customer reference-photo uploads (custom
-- order requests), distinct from catalogue-media (staff-only catalogue
-- post photos/videos, up to 50MB). Scoping these to their own bucket with
-- a real DB-enforced MIME/size policy closes a gap the shared bucket left
-- open: catalogue-media has no file_size_limit/allowed_mime_types at all,
-- so an anonymous uploader could otherwise store arbitrary content (e.g.
-- text/html) that a path-location-only URL check can't catch.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('catalogue-reference', 'catalogue-reference', true, 5242880,
        ARRAY['image/jpeg','image/png','image/webp','image/gif'])
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE POLICY "Public read catalogue reference"
  ON storage.objects FOR SELECT USING (bucket_id = 'catalogue-reference');
