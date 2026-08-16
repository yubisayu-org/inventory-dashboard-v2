-- A private bucket for group post images.
--
-- Separate from the catalogue branch's bucket on purpose: these two features
-- ship independently, and sharing a bucket would couple their retention and
-- access rules together for no benefit.
--
-- Private, not public: a post image shows a shop shelf and, once annotated,
-- who wants what. It is served through signed URLs from the dashboard rather
-- than being world-readable.
INSERT INTO storage.buckets (id, name, public)
VALUES ('wa-posts', 'wa-posts', false)
ON CONFLICT (id) DO NOTHING;
