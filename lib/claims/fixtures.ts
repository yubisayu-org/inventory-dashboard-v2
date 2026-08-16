import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Resolved against this file rather than the process working directory, so the
// tests pass whether they are run from the repo root or anywhere else.
const here = dirname(fileURLToPath(import.meta.url))

export const FIXTURES = {
  original: join(here, "__fixtures__", "original.jpg"),
  ticked: join(here, "__fixtures__", "ticked.jpg"),
  crop: join(here, "__fixtures__", "crop.jpg"),
} as const
