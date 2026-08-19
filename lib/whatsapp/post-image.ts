import { existsSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { downloadPostImage, downloadCatalogueImage } from "@/lib/storage"

/**
 * Where downloaded post images are kept.
 *
 * A cache, not storage: everything here can be re-fetched from the bucket, so
 * losing it on reboot costs one download.
 */
const CACHE_DIR = join(tmpdir(), "wa-post-cache")

/** A bucket key is a path with slashes; a filename is not. */
function cacheName(imagePath: string): string {
  return imagePath.replace(/[^a-zA-Z0-9._-]/g, "_")
}

/**
 * A readable filesystem path for a post's image.
 *
 * `wa_posts.image_path` holds a bucket object key in normal use, but the
 * resolver library takes filesystem paths throughout — it hands them to sharp —
 * and the ingest tests store a local fixture path directly. So a path that
 * already exists is returned untouched, and anything else is fetched from the
 * bucket.
 *
 * Fetched images are cached, because one shelf photo is compared against every
 * reply it receives: a busy post would otherwise pull the same megabyte out of
 * storage twenty times. Post images never change — the key contains the message
 * id — so the cache never needs invalidating.
 *
 * The download lands on a temporary name and is renamed into place, so two
 * replies arriving together cannot leave a half-written file for the other to
 * read.
 */
export async function localPostImage(imagePath: string): Promise<string> {
  if (existsSync(imagePath)) return imagePath

  await mkdir(CACHE_DIR, { recursive: true })
  const cached = join(CACHE_DIR, cacheName(imagePath))
  if (existsSync(cached)) return cached

  const buffer = await downloadPostImage(imagePath)
  const partial = `${cached}.${process.pid}.${Date.now()}.part`
  await writeFile(partial, buffer)
  await rename(partial, cached)
  return cached
}

/** The same, for a catalogue copy in the public bucket. */
async function localCatalogueImage(viewPath: string): Promise<string> {
  // As above: a path that already exists on disk is a fixture, not a bucket key.
  if (existsSync(viewPath)) return viewPath

  const cached = join(CACHE_DIR, cacheName(viewPath))
  if (existsSync(cached)) return cached

  await mkdir(CACHE_DIR, { recursive: true })
  const temporary = `${cached}.${process.pid}.part`
  await writeFile(temporary, await downloadCatalogueImage(viewPath))
  await rename(temporary, cached)
  return cached
}

/**
 * A readable file for a shelf, whichever copies still exist.
 *
 * A closed trip keeps only its catalogue AVIF — 2250px rather than 3000 — so
 * the screens that read a shelf degrade instead of failing: the rekap picture
 * and the naming crops still render from an archived trip, just softer. Nobody
 * is shopping it any more; they are looking something up.
 */
export async function localShelfImage(post: {
  imagePath: string
  viewPath: string
  archivedAt: string | null
}): Promise<string> {
  if (post.archivedAt === null) return localPostImage(post.imagePath)
  if (!post.viewPath) throw new Error(`post has no image left: ${post.imagePath}`)
  return localCatalogueImage(post.viewPath)
}
