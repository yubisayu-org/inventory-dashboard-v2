-- Public bucket for catalogue photo/video files. Uploads go through the
-- staff-only /api/sheets/catalogue-posts route using the service-role key
-- (which bypasses these policies entirely); the public SELECT policy is
-- what lets the customer-facing /catalogue page load files directly by URL.
INSERT INTO storage.buckets (id, name, public)
VALUES ('catalogue-media', 'catalogue-media', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public read catalogue media"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'catalogue-media');
