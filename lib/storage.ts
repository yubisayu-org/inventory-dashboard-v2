import { createClient, type SupabaseClient } from "@supabase/supabase-js"

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
 * storage policies to express a rule the app has already enforced.
 */
function storage(): SupabaseClient {
  if (client !== null) return client
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for post images")
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
