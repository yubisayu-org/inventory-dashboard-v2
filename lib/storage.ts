import { createClient, type SupabaseClient } from "@supabase/supabase-js"

/** Group post images. Private; see migration 063 for why. */
export const WA_POSTS_BUCKET = "wa-posts"

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
