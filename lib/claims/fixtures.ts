import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Resolved against this file rather than the process working directory, so the
// tests pass whether they are run from the repo root or anywhere else.
const here = dirname(fileURLToPath(import.meta.url))

export const FIXTURES = {
  original: join(here, "__fixtures__", "original.jpg"),
  ticked: join(here, "__fixtures__", "ticked.jpg"),
  crop: join(here, "__fixtures__", "crop.jpg"),
  // A second real pair, kept because it broke the resolver twice: the shelf is
  // full of green packaging, so green is excluded as a pen colour, and the
  // customer ticked in green.
  greenPost: join(here, "__fixtures__", "green-post.jpg"),
  greenTicked: join(here, "__fixtures__", "green-ticked.jpg"),
} as const
