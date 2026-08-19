import { createClient, type SupabaseClient } from "@supabase/supabase-js"

const CATALOGUE_MEDIA_BUCKET = "catalogue-media"
const MAX_PHOTO_BYTES = 5 * 1024 * 1024
const MAX_VIDEO_BYTES = 50 * 1024 * 1024

/** Group post images. Private; see migration 063 for why. */
export const WA_POSTS_BUCKET = "wa-posts"

/**
 * Catalogue copies of those images. Public; see migration 071.
 *
 * A downscaled AVIF of the same rack and nothing else — the originals, and
 * anything annotated, stay in the private bucket.
 */
export const WA_CATALOGUE_BUCKET = "wa-catalogue"

let client: SupabaseClient | null = null

/**
 * Storage client, created on first use.
 *
 * Lazy rather than module-level so that importing anything from this file does
 * not require the env to be present — the dashboard imports type-only paths in
 * places that never touch storage.
 *
 * The service role key is used because these objects are private and every
 * caller is already an authenticated owner or admin; the anon key would need
 * storage policies to express a rule the app has already enforced. It bypasses
 * RLS entirely, so this file must never be imported into any client component
 * or public-facing route.
 */
function storage(): SupabaseClient {
  if (client !== null) return client
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for storage access")
  }
  client = createClient(url, key, { auth: { persistSession: false } })
  return client
}

export async function uploadPostImage(
  path: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const { error } = await storage()
    .storage.from(WA_POSTS_BUCKET)
    .upload(path, body, { contentType, upsert: true })
  if (error) throw error
}

export async function downloadPostImage(path: string): Promise<Buffer> {
  const { data, error } = await storage().storage.from(WA_POSTS_BUCKET).download(path)
  if (error) throw error
  return Buffer.from(await data.arrayBuffer())
}

/**
 * A time-limited URL for the dashboard to render.
 *
 * Signed rather than public: the bucket holds shelf photos that, once
 * annotated, show who wants what.
 */
export async function postImageUrl(path: string, expiresInSeconds = 3600): Promise<string> {
  const { data, error } = await storage()
    .storage.from(WA_POSTS_BUCKET)
    .createSignedUrl(path, expiresInSeconds)
  if (error) throw error
  return data.signedUrl
}

export async function uploadCatalogueImage(
  path: string,
  body: Buffer,
  contentType = "image/avif",
): Promise<void> {
  const { error } = await storage()
    .storage.from(WA_CATALOGUE_BUCKET)
    .upload(path, body, {
      contentType,
      upsert: true,
      // A shelf photograph never changes once posted, so the copy handed to
      // customers can be cached for a year. This is the header that decides the
      // egress bill: each device fetches a rack once, ever.
      cacheControl: "31536000",
    })
  if (error) throw error
}

export async function downloadCatalogueImage(path: string): Promise<Buffer> {
  const { data, error } = await storage().storage.from(WA_CATALOGUE_BUCKET).download(path)
  if (error) throw error
  return Buffer.from(await data.arrayBuffer())
}

/** The public URL of a catalogue copy. No signing: the bucket is public. */
export function catalogueImageUrl(path: string): string {
  return storage().storage.from(WA_CATALOGUE_BUCKET).getPublicUrl(path).data.publicUrl
}

/**
 * Delete a full-size original, keeping its catalogue copy.
 *
 * What archiving a closed trip does. Missing is not an error: the point is that
 * the file should not be there afterwards.
 */
export async function deletePostImage(path: string): Promise<void> {
  const { error } = await storage().storage.from(WA_POSTS_BUCKET).remove([path])
  if (error) throw error
}

/** Staff-only Catalogue Posts upload — a browser File, not a worker-side
 *  Buffer, so it stays a separate pair of functions from the wa-post ones
 *  above rather than forcing a shared signature neither side needs. */
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

  const { error } = await storage().storage.from(CATALOGUE_MEDIA_BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: false,
  })
  if (error) throw new Error(`Upload failed: ${error.message}`)

  const { data } = storage().storage.from(CATALOGUE_MEDIA_BUCKET).getPublicUrl(path)
  return { url: data.publicUrl, mediaType: isVideo ? "video" : "photo" }
}

/** Best-effort cleanup for a file that was uploaded via uploadCatalogueMedia
 *  but whose DB row never got created (e.g. createCataloguePost failed after
 *  a successful upload). Never throws — logs and returns on failure, so a
 *  cleanup problem never masks the original error the caller is handling. */
export async function deleteCatalogueMedia(url: string): Promise<void> {
  const marker = `/public/${CATALOGUE_MEDIA_BUCKET}/`
  const idx = url.indexOf(marker)
  if (idx === -1) {
    console.error(`deleteCatalogueMedia: could not parse storage path from URL: ${url}`)
    return
  }
  const path = url.slice(idx + marker.length)

  const { error } = await storage().storage.from(CATALOGUE_MEDIA_BUCKET).remove([path])
  if (error) {
    console.error(`Failed to delete orphaned catalogue media at ${path}:`, error.message)
  }
}
