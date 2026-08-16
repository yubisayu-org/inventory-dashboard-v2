import { createClient } from "@supabase/supabase-js"

// Storage-only client — the service role key bypasses RLS entirely, so this
// must never be imported into any client component or public-facing route.
// Only the staff-only /api/sheets/catalogue-posts route uses this.
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const BUCKET = "catalogue-media"
// Separate, policy-constrained bucket for anonymous customer reference-photo
// uploads (custom order requests) — see migration 062. Kept distinct from
// BUCKET (staff-only catalogue post media) so the anonymous upload path is
// never widened onto the shared staff bucket.
const REFERENCE_BUCKET = "catalogue-reference"
const MAX_PHOTO_BYTES = 5 * 1024 * 1024
const MAX_VIDEO_BYTES = 50 * 1024 * 1024

export async function uploadCatalogueMedia(file: File): Promise<{ url: string; mediaType: "photo" | "video" }> {
  const isVideo = file.type.startsWith("video/")
  const isPhoto = file.type.startsWith("image/")
  if (!isVideo && !isPhoto) throw new Error("File must be an image or a video")

  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES
  if (file.size > maxBytes) {
    throw new Error(`File too large — max ${Math.round(maxBytes / 1024 / 1024)}MB for a ${isVideo ? "video" : "photo"}`)
  }

  const ext = file.name.split(".").pop() ?? "bin"
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`

  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: false,
  })
  if (error) throw new Error(`Upload failed: ${error.message}`)

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return { url: data.publicUrl, mediaType: isVideo ? "video" : "photo" }
}

/** Best-effort cleanup for a file that was uploaded via uploadCatalogueMedia
 *  but whose DB row never got created (e.g. createCataloguePost failed after
 *  a successful upload). Never throws — logs and returns on failure, so a
 *  cleanup problem never masks the original error the caller is handling. */
export async function deleteCatalogueMedia(url: string): Promise<void> {
  const marker = `/public/${BUCKET}/`
  const idx = url.indexOf(marker)
  if (idx === -1) {
    console.error(`deleteCatalogueMedia: could not parse storage path from URL: ${url}`)
    return
  }
  const path = url.slice(idx + marker.length)

  const { error } = await supabase.storage.from(BUCKET).remove([path])
  if (error) {
    console.error(`Failed to delete orphaned catalogue media at ${path}:`, error.message)
  }
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
}

/** Public path: lets an anonymous customer upload a reference photo
 *  directly to Storage via a signed URL, without ever needing a Supabase
 *  key in the browser (verified empirically: the returned uploadUrl works
 *  with a plain unauthenticated `fetch(uploadUrl, {method:'PUT', ...})` —
 *  no Authorization/apikey header required, matching Supabase's documented
 *  signed-upload-URL contract). The caller
 *  (app/api/public/catalogue/custom-upload-url/route.ts) is itself
 *  public/no-login — this function does exactly what that route needs.
 *  Images only (no video — reference photos, not catalogue post media),
 *  reusing the same MAX_PHOTO_BYTES cap uploadCatalogueMedia enforces
 *  server-side for the equivalent staff-upload case (this signed-URL path
 *  can't enforce a byte cap itself since the browser uploads directly to
 *  Storage — REFERENCE_BUCKET's own file_size_limit/allowed_mime_types,
 *  set in migration 062, IS the real DB-enforced backstop; this cap is a
 *  documentation anchor matching that policy, not a separate mechanism). */
export async function createCatalogueUploadUrl(
  contentType: string,
): Promise<{ uploadUrl: string; publicUrl: string }> {
  const ext = EXT_BY_CONTENT_TYPE[contentType]
  if (!ext) throw new Error("contentType must be image/jpeg, image/png, image/webp, or image/gif")

  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`

  const { data, error } = await supabase.storage.from(REFERENCE_BUCKET).createSignedUploadUrl(path)
  if (error) throw new Error(`Failed to create upload URL: ${error.message}`)

  const { data: publicData } = supabase.storage.from(REFERENCE_BUCKET).getPublicUrl(path)
  return { uploadUrl: data.signedUrl, publicUrl: publicData.publicUrl }
}
