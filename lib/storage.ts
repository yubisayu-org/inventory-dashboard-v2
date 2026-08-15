import { createClient } from "@supabase/supabase-js"

// Storage-only client — the service role key bypasses RLS entirely, so this
// must never be imported into any client component or public-facing route.
// Only the staff-only /api/sheets/catalogue-posts route uses this.
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const BUCKET = "catalogue-media"
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
