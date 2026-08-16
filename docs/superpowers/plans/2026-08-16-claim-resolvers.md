# Claim Resolver Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure-function library that turns a customer's WhatsApp reply into a resolved claim — mark position, matched crop region, or matched variant — with no database, no network, and no WhatsApp.

**Architecture:** Every resolver is a pure function over pixels or strings, living in `lib/claims/`. Image work goes through `sharp` at a small working width; nothing needs the original at full resolution. The library returns *positions and confidences*, never product identities — mapping a position to a product happens later, in the dashboard, after purchase.

**Tech Stack:** TypeScript, `sharp` (raster decode/resize), `node:test` via `tsx` (already a devDependency — no test framework is added).

**Spec:** [docs/superpowers/specs/2026-08-16-whatsapp-claim-capture-design.md](../specs/2026-08-16-whatsapp-claim-capture-design.md)

## Global Constraints

- Node `22.x` per `package.json` `engines`. Do not use APIs newer than Node 22.
- **No new runtime dependencies** beyond promoting `sharp` to a direct dependency. It is currently only a transitive dep of `next@16.2.6`; the library must not rely on that.
- **No test framework is added.** Tests use `node:test` + `node:assert/strict`, run through `tsx`.
- All coordinates crossing a function boundary are **normalized to 0..1** against the image they came from, never pixels. Replies arrive at whatever size WhatsApp chose.
- Resolvers are **pure**: no filesystem writes, no `console.log`, no database, no network.
- Comments explain *why*, matching the density of `lib/pricing.ts`. No comment that restates the next line.
- Assertions on measured image values use **tolerances**, never exact equality — JPEG re-encoding moves numbers slightly.

---

### Task 1: Test runner, fixtures, and sharp as a direct dependency

Establishes everything later tasks need to run: a test command, committed sample images, and `sharp` owned by this project rather than borrowed from Next.

**Files:**
- Modify: `package.json` (add `test` script, add `sharp` to `dependencies`)
- Create: `lib/claims/__fixtures__/original.jpg`
- Create: `lib/claims/__fixtures__/ticked.jpg`
- Create: `lib/claims/__fixtures__/crop.jpg`
- Create: `lib/claims/__fixtures__/README.md`
- Create: `lib/claims/fixtures.ts`
- Test: `lib/claims/fixtures.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `FIXTURES: { original: string; ticked: string; crop: string }` — absolute paths, from `lib/claims/fixtures.ts`.
  - `npm test` runs every `lib/claims/*.test.ts`.

- [ ] **Step 1: Add the test script and promote sharp**

Edit `package.json`. Add to `"scripts"`:

```json
"test": "tsx --test lib/claims/*.test.ts"
```

Add to `"dependencies"` (keep alphabetical ordering with the existing entries — it sorts after `postgres`):

```json
"sharp": "^0.34.5"
```

- [ ] **Step 2: Install so the direct dependency is recorded**

Run: `npm install`
Expected: `package-lock.json` updates; `npm ls sharp` now shows `sharp@0.34.x` as a direct dependency rather than only under `next`.

- [ ] **Step 3: Create the fixtures from the validated samples**

The originals live in the gitignored `scratchpad/wa-samples/`. Tests need committed copies, so downscale the 5.9 MB camera original and copy the two replies as-is (they are already small, and re-encoding them would destroy the WhatsApp compression artifacts the tests exist to survive).

```bash
mkdir -p lib/claims/__fixtures__
# Note the .then() rather than top-level await: `tsx -e` compiles as CJS, where
# top-level await is a hard error.
npx tsx -e "
import sharp from 'sharp'
sharp('scratchpad/wa-samples/original.jpg')
  .resize({ width: 1600 }).jpeg({ quality: 82 })
  .toFile('lib/claims/__fixtures__/original.jpg')
  .then((i) => console.log('wrote', i.size, 'bytes'))
"
cp scratchpad/wa-samples/ticked.jpg lib/claims/__fixtures__/ticked.jpg
cp scratchpad/wa-samples/crop.jpg   lib/claims/__fixtures__/crop.jpg
ls -la lib/claims/__fixtures__/
```

Expected: three files — roughly 585 KB, 165 KB and 78 KB.

- [ ] **Step 4: Document what the fixtures are**

Create `lib/claims/__fixtures__/README.md`:

```markdown
# Claim resolver fixtures

Real samples, captured 2026-08-16. They exist because every resolver in this
directory has to survive WhatsApp's re-encoding, and synthetic images do not
reproduce it.

- `original.jpg` — a shelf photo as posted to a group. Downscaled from the
  4284x5712 camera original purely to keep the repository small; the resolvers
  are scale-invariant, so this costs the tests nothing.
- `ticked.jpg` — the same photo returned by a customer with two green ticks
  drawn in WhatsApp. **Do not re-encode this file.** It carries the exact
  compression artifacts (960x1280 progressive JPEG) that the ink detector must
  tolerate, and cleaning it up would make the tests pass on data no customer
  ever sends.
- `crop.jpg` — a customer's claim by cropping: a *screenshot* of a zoomed view,
  so it is double-compressed, upscaled, and a different aspect ratio from the
  original. This is the worst realistic input to the matcher, which is why it is
  the one committed.

Ground truth, measured by hand against `original.jpg`:

- `ticked.jpg` carries exactly two marks, near (41%, 77%) and (24%, 79%).
- `crop.jpg` shows the pale green floral pyjama set, which sits at roughly
  x 46-77%, y 12-34% of the original.
```

- [ ] **Step 5: Write the failing fixture-path test**

Create `lib/claims/fixtures.test.ts`:

```typescript
import { test } from "node:test"
import assert from "node:assert/strict"
import { statSync } from "node:fs"
import { FIXTURES } from "./fixtures"

test("every fixture path points at a real, non-empty file", () => {
  for (const [name, path] of Object.entries(FIXTURES)) {
    const stat = statSync(path)
    assert.ok(stat.isFile(), `${name} is not a file: ${path}`)
    assert.ok(stat.size > 1000, `${name} is suspiciously small: ${stat.size} bytes`)
  }
})
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./fixtures`.

- [ ] **Step 7: Implement the fixture paths**

Create `lib/claims/fixtures.ts`:

```typescript
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
```

- [ ] **Step 8: Run the test to confirm it passes**

Run: `npm test`
Expected: PASS, 1 test.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json lib/claims/
git commit -m "test: claim-resolver test harness and real WhatsApp fixtures

Tests run on node:test through tsx, which is already a devDependency, so no
test framework enters the project. sharp is promoted to a direct dependency —
it was only reachable as a transitive dep of next, which this library must not
rely on.

The fixtures are real captures rather than synthetic images because every
resolver here exists to survive WhatsApp's re-encoding. The reply files are
copied byte-for-byte for the same reason: cleaning them up would make the tests
pass on data no customer ever sends."
```

---

### Task 2: Raster loading and HSV conversion

The shared pixel layer. Every image resolver starts by decoding to a small raster; doing it once here keeps `sharp` out of the resolvers themselves and makes them trivially testable.

**Files:**
- Create: `lib/claims/raster.ts`
- Test: `lib/claims/raster.test.ts`

**Interfaces:**
- Consumes: `FIXTURES` from Task 1.
- Produces:
  - `interface RgbRaster { data: Uint8Array; width: number; height: number }` — 3 bytes per pixel, row-major.
  - `interface GrayRaster { data: Uint8Array; width: number; height: number }` — 1 byte per pixel.
  - `loadRgb(path: string, width: number): Promise<RgbRaster>`
  - `loadGray(path: string, width: number): Promise<GrayRaster>`
  - `rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number }` — `h` in degrees 0..360, `s` and `v` in 0..1.

- [ ] **Step 1: Write the failing tests**

Create `lib/claims/raster.test.ts`:

```typescript
import { test } from "node:test"
import assert from "node:assert/strict"
import { FIXTURES } from "./fixtures"
import { loadRgb, loadGray, rgbToHsv } from "./raster"

test("rgbToHsv places primaries on the right hues", () => {
  assert.equal(Math.round(rgbToHsv(255, 0, 0).h), 0)
  assert.equal(Math.round(rgbToHsv(0, 255, 0).h), 120)
  assert.equal(Math.round(rgbToHsv(0, 0, 255).h), 240)
})

test("rgbToHsv reports greys as unsaturated", () => {
  const { s, v } = rgbToHsv(128, 128, 128)
  assert.equal(s, 0)
  assert.ok(Math.abs(v - 128 / 255) < 0.01)
})

test("rgbToHsv reports black without dividing by zero", () => {
  const { h, s, v } = rgbToHsv(0, 0, 0)
  assert.equal(h, 0)
  assert.equal(s, 0)
  assert.equal(v, 0)
})

test("loadRgb decodes to the requested width with three channels", async () => {
  const raster = await loadRgb(FIXTURES.ticked, 240)
  assert.equal(raster.width, 240)
  assert.ok(raster.height > 240, "the fixture is portrait, so height should exceed width")
  assert.equal(raster.data.length, raster.width * raster.height * 3)
})

test("loadGray decodes to one channel per pixel", async () => {
  const raster = await loadGray(FIXTURES.ticked, 240)
  assert.equal(raster.width, 240)
  assert.equal(raster.data.length, raster.width * raster.height)
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./raster`.

- [ ] **Step 3: Implement**

Create `lib/claims/raster.ts`:

```typescript
import sharp from "sharp"

/** Decoded pixels, row-major, 3 bytes per pixel. */
export interface RgbRaster {
  data: Uint8Array
  width: number
  height: number
}

/** Decoded luminance, row-major, 1 byte per pixel. */
export interface GrayRaster {
  data: Uint8Array
  width: number
  height: number
}

/**
 * Decode an image to raw RGB at a working width.
 *
 * Every resolver works on a downscaled copy: pen strokes and shelf items are
 * large features, and full resolution would cost seconds per claim while
 * changing no answer. Height follows the source aspect ratio — replies arrive
 * at whatever size WhatsApp chose, so nothing may assume a shape.
 */
export async function loadRgb(path: string, width: number): Promise<RgbRaster> {
  const { data, info } = await sharp(path)
    .resize({ width })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), width: info.width, height: info.height }
}

/** Luminance-only decode, for the shape-matching resolvers where colour is noise. */
export async function loadGray(path: string, width: number): Promise<GrayRaster> {
  const { data, info } = await sharp(path)
    .greyscale()
    .resize({ width })
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), width: info.width, height: info.height }
}

/**
 * RGB to HSV. Hue in degrees, saturation and value in 0..1.
 *
 * Hue and saturation are what separate pen ink from photographed goods: pen is
 * a narrow hue at extreme saturation, while dyed fabric under shop lighting is
 * neither. RGB distance cannot express that, which is why this conversion
 * exists rather than thresholding channels directly.
 */
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const chroma = max - min

  const v = max / 255
  const s = max === 0 ? 0 : chroma / max

  // Undefined hue for greys; 0 is as good as any other answer and avoids a NaN
  // escaping into the callers' comparisons.
  if (chroma === 0) return { h: 0, s, v }

  let h: number
  if (max === r) h = 60 * (((g - b) / chroma) % 6)
  else if (max === g) h = 60 * ((b - r) / chroma + 2)
  else h = 60 * ((r - g) / chroma + 4)

  return { h: h < 0 ? h + 360 : h, s, v }
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npm test`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/claims/raster.ts lib/claims/raster.test.ts
git commit -m "feat(claims): raster loading and HSV conversion

Resolvers work on a downscaled copy because pen strokes and shelf items are
large features — full resolution would cost seconds per claim and change no
answer. Height is never assumed: replies arrive at whatever size WhatsApp chose.

HSV rather than RGB thresholds because hue and saturation are exactly what
separate pen ink from photographed goods, and RGB distance cannot express that."
```

---

### Task 3: Per-post hue histogram and safe pen colours

The spike found that thresholding on saturation alone picks out a red shop sign. Since the original post is always available, its own hues say which pen colours can be trusted for that photo.

**Files:**
- Create: `lib/claims/hue.ts`
- Test: `lib/claims/hue.test.ts`

**Interfaces:**
- Consumes: `RgbRaster`, `rgbToHsv`, `loadRgb` from Task 2; `FIXTURES` from Task 1.
- Produces:
  - `HUE_BUCKETS = 36` — 10° per bucket.
  - `PEN_COLOURS: readonly { name: string; hue: number }[]` — WhatsApp's pen palette.
  - `hueHistogram(raster: RgbRaster): number[]` — length 36, counts of *vivid* pixels per bucket.
  - `safePenHues(histogram: number[], pixelCount: number): { name: string; hue: number }[]`

- [ ] **Step 1: Write the failing tests**

Create `lib/claims/hue.test.ts`:

```typescript
import { test } from "node:test"
import assert from "node:assert/strict"
import { FIXTURES } from "./fixtures"
import { loadRgb } from "./raster"
import { hueHistogram, safePenHues, HUE_BUCKETS, PEN_COLOURS } from "./hue"

test("histogram has one bucket per ten degrees", async () => {
  const raster = await loadRgb(FIXTURES.original, 240)
  const histogram = hueHistogram(raster)
  assert.equal(histogram.length, HUE_BUCKETS)
  assert.ok(histogram.every((n) => Number.isInteger(n) && n >= 0))
})

test("the shelf photo registers its red signage", async () => {
  const raster = await loadRgb(FIXTURES.original, 240)
  const histogram = hueHistogram(raster)
  // The shop's red PRICE DOWN sign lives in the first bucket (0-10 degrees).
  // This is the collision that makes red pen unusable on this photo.
  assert.ok(histogram[0] > 0, "expected vivid red pixels in the shelf photo")
})

test("the shelf photo contains no pen-green at all", async () => {
  const raster = await loadRgb(FIXTURES.original, 240)
  const histogram = hueHistogram(raster)
  // Buckets 12..14 cover 120-150 degrees, where WhatsApp's green pen sits.
  const green = histogram[12] + histogram[13] + histogram[14]
  assert.equal(green, 0, "baby clothes are not pen-green; a non-zero count means the vividness threshold is too loose")
})

test("green is offered as a safe pen for this photo and red is not", async () => {
  const raster = await loadRgb(FIXTURES.original, 240)
  const histogram = hueHistogram(raster)
  const safe = safePenHues(histogram, raster.width * raster.height).map((c) => c.name)
  assert.ok(safe.includes("green"), "green must be safe — the photo has none")
  assert.ok(!safe.includes("red"), "red must be rejected — the photo's signage is red")
})

test("an empty histogram makes every pen colour safe", () => {
  const safe = safePenHues(new Array(HUE_BUCKETS).fill(0), 100_000)
  assert.equal(safe.length, PEN_COLOURS.length)
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./hue`.

- [ ] **Step 3: Implement**

Create `lib/claims/hue.ts`:

```typescript
import { rgbToHsv, type RgbRaster } from "./raster"

/** 10 degrees per bucket — finer than pen colours differ, coarser than JPEG noise. */
export const HUE_BUCKETS = 36

/**
 * A pixel counts toward the histogram only if it is *vivid*: both strongly
 * saturated and reasonably bright.
 *
 * These thresholds are what make the histogram mean "a colour that could be
 * confused with ink" rather than "a colour that appears". Dyed fabric,
 * packaging and shop shelving all sit below them; pen strokes sit far above.
 * Measured on the fixture: pen-green scores zero across the whole shelf.
 */
const VIVID_S = 0.35
const VIVID_V = 0.35

/**
 * WhatsApp's drawing palette, by hue.
 *
 * White and black pens are deliberately absent: they carry no hue, so they
 * cannot be told apart from highlights and shadow, which every photograph has.
 * A customer drawing in white or black lands in review.
 */
export const PEN_COLOURS = [
  { name: "red", hue: 0 },
  { name: "orange", hue: 30 },
  { name: "yellow", hue: 55 },
  { name: "green", hue: 130 },
  { name: "cyan", hue: 190 },
  { name: "blue", hue: 225 },
  { name: "purple", hue: 280 },
  { name: "pink", hue: 320 },
] as const

/** Vivid-pixel counts per 10-degree hue bucket. */
export function hueHistogram(raster: RgbRaster): number[] {
  const histogram = new Array<number>(HUE_BUCKETS).fill(0)
  for (let i = 0; i < raster.data.length; i += 3) {
    const { h, s, v } = rgbToHsv(raster.data[i], raster.data[i + 1], raster.data[i + 2])
    if (s < VIVID_S || v < VIVID_V) continue
    const bucket = Math.min(HUE_BUCKETS - 1, Math.floor(h / (360 / HUE_BUCKETS)))
    histogram[bucket]++
  }
  return histogram
}

/**
 * A pen colour is safe for a given post when the post itself has essentially
 * none of that hue, so any such pixel in a reply must be ink.
 *
 * The window is +/- 2 buckets (20 degrees either side) because JPEG chroma
 * subsampling smears hue at the edges of a stroke, and because customers do not
 * pick the exact palette entry the histogram was built around.
 *
 * The tolerance is proportional to frame size rather than absolute: a handful
 * of stray vivid pixels in a large photo is noise, but the same count in a
 * thumbnail is a real feature.
 */
export function safePenHues(
  histogram: number[],
  pixelCount: number,
): { name: string; hue: number }[] {
  const tolerance = pixelCount * 0.0002
  return PEN_COLOURS.filter(({ hue }) => {
    const centre = Math.floor(hue / (360 / HUE_BUCKETS))
    let nearby = 0
    for (let d = -2; d <= 2; d++) {
      nearby += histogram[(centre + d + HUE_BUCKETS) % HUE_BUCKETS]
    }
    return nearby <= tolerance
  }).map((c) => ({ name: c.name, hue: c.hue }))
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npm test`
Expected: PASS, 11 tests total.

These assertions were measured against the real fixture at 240px working width
before this plan was written, so they are facts rather than guesses: red bucket
**1138**, the three green buckets **0**, tolerance **15.4** pixels, and
`safePenHues` returning exactly **green and purple**. If your numbers differ
wildly, suspect the fixture rather than the code.

- [ ] **Step 5: Commit**

```bash
git add lib/claims/hue.ts lib/claims/hue.test.ts
git commit -m "feat(claims): per-post hue histogram and safe pen colours

Thresholding on saturation alone finds the shop's red PRICE DOWN sign instead
of the customer's ticks, so red pen would collide on the very first sample
photo. The original post is always on hand, so its own hues decide which pens
can be trusted for that photo — and can tell the owner which pen to ask for.

White and black pens are excluded by construction: they carry no hue, so they
are indistinguishable from highlights and shadow, which every photograph has."
```

---

### Task 4: Ink mark detection

Finds pen marks in a reply using only the reply. No comparison against the original, so no image registration — which is what makes the resized, re-encoded, sometimes-cropped replies tractable at all.

**Files:**
- Create: `lib/claims/ink.ts`
- Test: `lib/claims/ink.test.ts`

**Interfaces:**
- Consumes: `RgbRaster`, `rgbToHsv`, `loadRgb` (Task 2); `safePenHues`, `hueHistogram` (Task 3); `FIXTURES` (Task 1).
- Produces:
  - `interface Point { x: number; y: number }` — normalized 0..1.
  - `interface Mark { point: Point; pixels: number }`
  - `detectMarks(raster: RgbRaster, hues: number[], minPixels?: number): Mark[]` — sorted by `pixels` descending.

- [ ] **Step 1: Write the failing tests**

Create `lib/claims/ink.test.ts`:

```typescript
import { test } from "node:test"
import assert from "node:assert/strict"
import { FIXTURES } from "./fixtures"
import { loadRgb } from "./raster"
import { hueHistogram, safePenHues } from "./hue"
import { detectMarks } from "./ink"

const GREEN = [130]

test("finds exactly the two ticks a customer drew", async () => {
  const raster = await loadRgb(FIXTURES.ticked, 480)
  const marks = detectMarks(raster, GREEN)
  assert.equal(marks.length, 2, `expected 2 marks, got ${marks.length}`)
})

test("the marks land where the customer put them", async () => {
  const raster = await loadRgb(FIXTURES.ticked, 480)
  const marks = detectMarks(raster, GREEN)
  const sorted = [...marks].sort((a, b) => a.point.x - b.point.x)

  // Ground truth measured by hand — see __fixtures__/README.md.
  assert.ok(Math.abs(sorted[0].point.x - 0.244) < 0.04, `left mark x was ${sorted[0].point.x}`)
  assert.ok(Math.abs(sorted[0].point.y - 0.789) < 0.04, `left mark y was ${sorted[0].point.y}`)
  assert.ok(Math.abs(sorted[1].point.x - 0.414) < 0.04, `right mark x was ${sorted[1].point.x}`)
  assert.ok(Math.abs(sorted[1].point.y - 0.767) < 0.04, `right mark y was ${sorted[1].point.y}`)
})

test("an unmarked photo yields nothing", async () => {
  const raster = await loadRgb(FIXTURES.original, 480)
  const marks = detectMarks(raster, GREEN)
  assert.equal(marks.length, 0, "the unmarked original must produce no marks at all")
})

test("a hue the photo is full of produces false marks — which is why hues are chosen per post", async () => {
  const raster = await loadRgb(FIXTURES.original, 480)
  // Red is exactly the pen colour safePenHues rejects for this photo. Asserting
  // the failure keeps the reason for that machinery visible.
  const marks = detectMarks(raster, [0])
  assert.ok(marks.length > 0, "expected the red signage to be picked up when red is wrongly trusted")
})

test("safe hues from the post drive detection end to end", async () => {
  const post = await loadRgb(FIXTURES.original, 240)
  const safe = safePenHues(hueHistogram(post), post.width * post.height).map((c) => c.hue)

  const reply = await loadRgb(FIXTURES.ticked, 480)
  const marks = detectMarks(reply, safe)
  assert.equal(marks.length, 2)
})

test("marks come back largest first", async () => {
  const raster = await loadRgb(FIXTURES.ticked, 480)
  const marks = detectMarks(raster, GREEN)
  assert.ok(marks[0].pixels >= marks[1].pixels)
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./ink`.

- [ ] **Step 3: Implement**

Create `lib/claims/ink.ts`:

```typescript
import { rgbToHsv, type RgbRaster } from "./raster"

/** A position on an image, normalized so it survives WhatsApp's resizing. */
export interface Point {
  x: number
  y: number
}

export interface Mark {
  point: Point
  /** Size of the blob, in working-resolution pixels. Bigger is more confident. */
  pixels: number
}

/** How far from a trusted hue a pixel may sit and still count as that ink. */
const HUE_TOLERANCE = 25
const INK_S = 0.35
const INK_V = 0.35

/** Below this, a blob is compression noise rather than a deliberate stroke. */
const DEFAULT_MIN_PIXELS = 40

function isInk(h: number, s: number, v: number, hues: number[]): boolean {
  if (s < INK_S || v < INK_V) return false
  return hues.some((hue) => {
    // Hue is circular: red at 0 and red at 355 are the same colour.
    const delta = Math.abs(((h - hue + 540) % 360) - 180)
    return 180 - delta <= HUE_TOLERANCE
  })
}

/**
 * Locate pen marks in a reply image.
 *
 * Works on the reply ALONE. Nothing here compares against the original, so
 * there is no registration step — which matters because replies come back
 * resized, re-encoded, and sometimes cropped, and aligning two such images
 * would be the hardest part of this whole system.
 *
 * `hues` must come from safePenHues() for the post being replied to. Passing a
 * hue the photo itself contains will return that photo's own contents as marks.
 */
export function detectMarks(
  raster: RgbRaster,
  hues: number[],
  minPixels: number = DEFAULT_MIN_PIXELS,
): Mark[] {
  const { width: w, height: h, data } = raster
  const mask = new Uint8Array(w * h)

  for (let i = 0, p = 0; i < data.length; i += 3, p++) {
    const hsv = rgbToHsv(data[i], data[i + 1], data[i + 2])
    if (isInk(hsv.h, hsv.s, hsv.v, hues)) mask[p] = 1
  }

  // Connected components, 8-neighbour. An explicit stack rather than recursion:
  // a long stroke is thousands of pixels deep and would overflow the call stack.
  const seen = new Uint8Array(w * h)
  const marks: Mark[] = []
  const stack: number[] = []

  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue
    stack.length = 0
    stack.push(start)
    seen[start] = 1

    let count = 0
    let sumX = 0
    let sumY = 0

    while (stack.length > 0) {
      const p = stack.pop() as number
      const x = p % w
      const y = (p / w) | 0
      count++
      sumX += x
      sumY += y

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const q = ny * w + nx
          if (mask[q] && !seen[q]) {
            seen[q] = 1
            stack.push(q)
          }
        }
      }
    }

    if (count >= minPixels) {
      marks.push({ point: { x: sumX / count / w, y: sumY / count / h }, pixels: count })
    }
  }

  return marks.sort((a, b) => b.pixels - a.pixels)
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npm test`
Expected: PASS, 17 tests total.

- [ ] **Step 5: Commit**

```bash
git add lib/claims/ink.ts lib/claims/ink.test.ts
git commit -m "feat(claims): detect pen marks from the reply alone

No comparison against the original, so no image registration — which is what
makes resized, re-encoded, sometimes-cropped replies tractable at all. On the
real sample this finds exactly the two ticks and nothing on the unmarked photo.

One test deliberately asserts a false positive: trusting red on a photo with red
signage returns the signage. It documents why hues are chosen per post rather
than fixed, so nobody later 'simplifies' that away."
```

---

### Task 5: Locating a crop or re-post inside the original

Handles two claim shapes with one algorithm: a customer who crops to the item they want, and a customer who sends the whole photo back with their request in the caption. What separates them is how much of the original the match covers.

**Files:**
- Create: `lib/claims/locate.ts`
- Test: `lib/claims/locate.test.ts`

**Interfaces:**
- Consumes: `GrayRaster`, `loadGray` (Task 2); `Point` (Task 4); `FIXTURES` (Task 1).
- Produces:
  - `interface Region { x: number; y: number; w: number; h: number }` — normalized.
  - `interface Located { region: Region; centre: Point; score: number; runnerUp: number; kind: "crop" | "repost" }`
  - `locateInPost(postPath: string, replyPath: string): Promise<Located | null>` — `null` when nothing scores above the floor.

- [ ] **Step 1: Write the failing tests**

Create `lib/claims/locate.test.ts`:

```typescript
import { test } from "node:test"
import assert from "node:assert/strict"
import { FIXTURES } from "./fixtures"
import { locateInPost } from "./locate"

test("finds the item a customer cropped to, from a screenshot", async () => {
  // The fixture is the worst realistic input: a screenshot of a zoomed view, so
  // it is double-compressed, upscaled, and a different aspect to the original.
  const found = await locateInPost(FIXTURES.original, FIXTURES.crop)
  assert.ok(found, "expected a match")
  assert.equal(found.kind, "crop")

  // Ground truth: the pale green floral pyjama set — see __fixtures__/README.md.
  assert.ok(Math.abs(found.centre.x - 0.615) < 0.08, `centre.x was ${found.centre.x}`)
  assert.ok(Math.abs(found.centre.y - 0.231) < 0.08, `centre.y was ${found.centre.y}`)
})

test("a crop match is confident and unambiguous", async () => {
  const found = await locateInPost(FIXTURES.original, FIXTURES.crop)
  assert.ok(found)
  assert.ok(found.score > 0.85, `score was ${found.score}`)
  assert.ok(found.score - found.runnerUp > 0.15, `margin was ${found.score - found.runnerUp}`)
})

test("the whole photo sent back is a repost, not a crop", async () => {
  // ticked.jpg is the full frame — same content, WhatsApp-resized. It should be
  // recognised as pointing at the post rather than at any item within it.
  const found = await locateInPost(FIXTURES.original, FIXTURES.ticked)
  assert.ok(found, "expected a match")
  assert.equal(found.kind, "repost")
})

test("an unrelated image matches nothing", async () => {
  // The crop as its own scene: a 723x683 close-up cannot contain the shelf.
  const found = await locateInPost(FIXTURES.crop, FIXTURES.original)
  assert.equal(found, null)
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./locate`.

- [ ] **Step 3: Implement**

Create `lib/claims/locate.ts`:

```typescript
import { loadGray, type GrayRaster } from "./raster"
import type { Point } from "./ink"

export interface Region {
  x: number
  y: number
  w: number
  h: number
}

export interface Located {
  region: Region
  centre: Point
  /** Normalized correlation of the winning position, 0..1. */
  score: number
  /** Best score at a position well away from the winner — the ambiguity check. */
  runnerUp: number
  /**
   * "repost" when the match covers essentially the whole frame: the customer
   * sent the photo back rather than cropping, so the image says WHICH POST and
   * the caption says what they want. "crop" when it covers a region, which is
   * itself the claim.
   */
  kind: "crop" | "repost"
}

/** Scene width for the search. Coarse deliberately — this locates, it does not inspect. */
const SCENE_W = 260
/** Template widths swept, as a fraction of scene width. */
const MIN_SCALE = 0.12
const MAX_SCALE = 0.95
const SCALE_STEP = 0.04
/** Below this the "match" is a coincidence of texture. */
const SCORE_FLOOR = 0.7
/** At or above this share of the frame, the reply is the whole photo. */
const REPOST_COVERAGE = 0.6

/**
 * A fixed lattice of sample points over the template.
 *
 * Full-pixel correlation is needlessly expensive here and changes no decision:
 * we are locating a hand-sized region, not registering pixels. A few hundred
 * samples is enough to separate the right position from every other one.
 */
function lattice(w: number, h: number, target = 360): number[][] {
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / target)))
  const points: number[][] = []
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) points.push([x, y])
  }
  return points
}

interface Placement {
  score: number
  runnerUp: number
  ox: number
  oy: number
  tw: number
  th: number
}

/** Best normalized-correlation placement of one template size within the scene. */
function bestPlacement(scene: GrayRaster, template: GrayRaster): Placement | null {
  if (template.width >= scene.width || template.height >= scene.height) return null

  const points = lattice(template.width, template.height)

  let templateMean = 0
  for (const [x, y] of points) templateMean += template.data[y * template.width + x]
  templateMean /= points.length

  let templateVariance = 0
  for (const [x, y] of points) {
    const d = template.data[y * template.width + x] - templateMean
    templateVariance += d * d
  }
  const templateSd = Math.sqrt(templateVariance)
  // A flat template correlates with everything equally; refuse to guess.
  if (templateSd === 0) return null

  let best: Placement | null = null
  let runnerUp = -1

  for (let oy = 0; oy + template.height < scene.height; oy++) {
    for (let ox = 0; ox + template.width < scene.width; ox++) {
      let sceneMean = 0
      for (const [x, y] of points) sceneMean += scene.data[(oy + y) * scene.width + ox + x]
      sceneMean /= points.length

      let covariance = 0
      let sceneVariance = 0
      for (const [x, y] of points) {
        const sv = scene.data[(oy + y) * scene.width + ox + x] - sceneMean
        const tv = template.data[y * template.width + x] - templateMean
        covariance += sv * tv
        sceneVariance += sv * sv
      }

      const denominator = Math.sqrt(sceneVariance) * templateSd
      const score = denominator === 0 ? 0 : covariance / denominator

      // The runner-up only counts if it is a genuinely different position.
      // Neighbouring offsets score nearly as well as the winner by construction,
      // and treating those as competition would call every match ambiguous.
      const farFromBest =
        best === null ||
        Math.abs(best.ox - ox) > template.width / 2 ||
        Math.abs(best.oy - oy) > template.height / 2

      if (best === null || score > best.score) {
        if (best !== null && farFromBest && best.score > runnerUp) runnerUp = best.score
        best = { score, runnerUp, ox, oy, tw: template.width, th: template.height }
      } else if (farFromBest && score > runnerUp) {
        runnerUp = score
      }
    }
  }

  return best === null ? null : { ...best, runnerUp }
}

/**
 * Find where a reply image sits inside the post it replies to.
 *
 * A crop is an exact sub-rectangle of a known image, so this is template
 * matching rather than recognition — no model, no per-claim cost. Scale is
 * unknown (customers zoom before cropping, and WhatsApp resizes), so the search
 * sweeps template sizes and keeps the best.
 *
 * The correlation score doubles as confidence: a wide margin over the runner-up
 * means one position clearly won, while a narrow one means repeated stock or a
 * crop showing only fabric texture, and the claim belongs in review.
 */
export async function locateInPost(postPath: string, replyPath: string): Promise<Located | null> {
  const scene = await loadGray(postPath, SCENE_W)

  let best: Placement | null = null
  for (let scale = MIN_SCALE; scale <= MAX_SCALE; scale += SCALE_STEP) {
    const width = Math.round(SCENE_W * scale)
    const template = await loadGray(replyPath, width)
    const placement = bestPlacement(scene, template)
    if (placement !== null && (best === null || placement.score > best.score)) best = placement
  }

  if (best === null || best.score < SCORE_FLOOR) return null

  const region: Region = {
    x: best.ox / scene.width,
    y: best.oy / scene.height,
    w: best.tw / scene.width,
    h: best.th / scene.height,
  }

  return {
    region,
    centre: { x: region.x + region.w / 2, y: region.y + region.h / 2 },
    score: best.score,
    runnerUp: best.runnerUp,
    kind: region.w * region.h >= REPOST_COVERAGE ? "repost" : "crop",
  }
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npm test`
Expected: PASS, 21 tests total. The locate tests are the slow ones — a few seconds each is normal.

- [ ] **Step 5: Commit**

```bash
git add lib/claims/locate.ts lib/claims/locate.test.ts
git commit -m "feat(claims): locate a crop or re-post inside the original photo

A crop is an exact sub-rectangle of a known image, so this is template matching
rather than recognition — no model, no per-claim cost. Scale is swept because
customers zoom before cropping and WhatsApp resizes on the way through.

Coverage separates the two claim shapes: a match over most of the frame means
the customer sent the whole photo back, where the image identifies the post and
the caption carries the request; a smaller match is itself the claim.

The runner-up is measured only at positions well away from the winner.
Neighbouring offsets score nearly as well by construction, and counting those as
competition would mark every match ambiguous."
```

---

### Task 6: Resolving text claims against a post's variants

For a product post, the variants are declared in a note when posting. Matching free-form Indonesian against a closed set of fifteen options is a far smaller problem than parsing it in the open.

**Files:**
- Create: `lib/claims/text.ts`
- Test: `lib/claims/text.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface Variant { id: string; dimensions: Record<string, string> }`
  - `interface TextClaim { variantId: string | null; quantity: number; missing: string[]; candidates: string[] }`
  - `parseVariantNote(note: string): { dimensions: Record<string, string[]>; variants: Variant[] }`
  - `resolveText(text: string, variants: Variant[], dimensions: Record<string, string[]>): TextClaim`

- [ ] **Step 1: Write the failing tests**

Create `lib/claims/text.test.ts`:

```typescript
import { test } from "node:test"
import assert from "node:assert/strict"
import { parseVariantNote, resolveText } from "./text"

const NOTE = "warna: hitam/merah/putih\nsize: 38-42"

test("a note expands into every combination", () => {
  const { dimensions, variants } = parseVariantNote(NOTE)
  assert.deepEqual(dimensions.warna, ["hitam", "merah", "putih"])
  assert.deepEqual(dimensions.size, ["38", "39", "40", "41", "42"])
  assert.equal(variants.length, 15)
})

test("resolves a complete claim", () => {
  const { dimensions, variants } = parseVariantNote(NOTE)
  const claim = resolveText("hitam 38", variants, dimensions)
  assert.equal(claim.quantity, 1)
  assert.deepEqual(claim.missing, [])
  const variant = variants.find((v) => v.id === claim.variantId)
  assert.deepEqual(variant?.dimensions, { warna: "hitam", size: "38" })
})

test("resolves a claim buried in a sentence", () => {
  const { dimensions, variants } = parseVariantNote(NOTE)
  const claim = resolveText("yg merah ukuran 40 dong kak", variants, dimensions)
  const variant = variants.find((v) => v.id === claim.variantId)
  assert.deepEqual(variant?.dimensions, { warna: "merah", size: "40" })
})

test("reads an explicit quantity", () => {
  const { dimensions, variants } = parseVariantNote(NOTE)
  assert.equal(resolveText("hitam 38 x2", variants, dimensions).quantity, 2)
  assert.equal(resolveText("mau 3 putih 41", variants, dimensions).quantity, 3)
})

test("a size alone reports the missing dimension rather than guessing", () => {
  const { dimensions, variants } = parseVariantNote(NOTE)
  const claim = resolveText("38", variants, dimensions)
  assert.equal(claim.variantId, null)
  assert.deepEqual(claim.missing, ["warna"])
  // The candidates are what the bot offers back: "warna apa kak?"
  assert.deepEqual(claim.candidates.sort(), ["hitam", "merah", "putih"])
})

test("text with nothing recognisable resolves to nothing", () => {
  const { dimensions, variants } = parseVariantNote(NOTE)
  const claim = resolveText("halo kak masih ada?", variants, dimensions)
  assert.equal(claim.variantId, null)
  assert.deepEqual(claim.missing.sort(), ["size", "warna"])
})

test("a quantity is never mistaken for a size", () => {
  const { dimensions, variants } = parseVariantNote(NOTE)
  // "2" is not a size in this note, so it can only be a count.
  const claim = resolveText("hitam 38 2pcs", variants, dimensions)
  assert.equal(claim.quantity, 2)
  const variant = variants.find((v) => v.id === claim.variantId)
  assert.equal(variant?.dimensions.size, "38")
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./text`.

- [ ] **Step 3: Implement**

Create `lib/claims/text.ts`:

```typescript
/** One sellable combination, e.g. { warna: "hitam", size: "38" }. */
export interface Variant {
  id: string
  dimensions: Record<string, string>
}

export interface TextClaim {
  /** Null when the text did not pin down exactly one variant. */
  variantId: string | null
  quantity: number
  /** Dimension names still unanswered — what the bot asks about. */
  missing: string[]
  /** Options for the first missing dimension, for the question the owner sends. */
  candidates: string[]
}

/**
 * Expand an owner's free-text note into the closed set of variants.
 *
 * Format is deliberately loose — one dimension per line, "name: a/b/c", with
 * numeric ranges written "38-42". The owner types this while posting, on a
 * phone, so anything stricter would not get used.
 *
 * The set is what makes text claims tractable: matching against fifteen known
 * options is a far smaller problem than parsing Indonesian in the open, which
 * is why no per-variant short codes appear in the caption.
 */
export function parseVariantNote(note: string): {
  dimensions: Record<string, string[]>
  variants: Variant[]
} {
  const dimensions: Record<string, string[]> = {}

  for (const line of note.split("\n")) {
    const [rawName, rawValues] = line.split(":")
    if (rawValues === undefined) continue
    const name = rawName.trim().toLowerCase()
    if (name === "") continue

    const values: string[] = []
    for (const chunk of rawValues.split("/")) {
      const value = chunk.trim().toLowerCase()
      if (value === "") continue

      // "38-42" means every size in between, which is how sizes are always
      // written and never means two values.
      const range = value.match(/^(\d+)\s*-\s*(\d+)$/)
      if (range) {
        const from = Number(range[1])
        const to = Number(range[2])
        for (let n = Math.min(from, to); n <= Math.max(from, to); n++) values.push(String(n))
        continue
      }
      values.push(value)
    }
    if (values.length > 0) dimensions[name] = values
  }

  const names = Object.keys(dimensions)
  let combinations: Record<string, string>[] = [{}]
  for (const name of names) {
    const next: Record<string, string>[] = []
    for (const partial of combinations) {
      for (const value of dimensions[name]) next.push({ ...partial, [name]: value })
    }
    combinations = next
  }

  const variants = combinations.map((d) => ({
    id: names.map((n) => d[n]).join("|"),
    dimensions: d,
  }))

  return { dimensions, variants }
}

/**
 * Match a customer's words against the post's variants.
 *
 * Word-boundary matching, not substring: "putih" must not match inside another
 * word, and a bare "40" must not match "402". Everything is compared in lower
 * case with punctuation flattened, because customers type as they speak.
 */
export function resolveText(
  text: string,
  variants: Variant[],
  dimensions: Record<string, string[]>,
): TextClaim {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/)
  const wordSet = new Set(words)

  const chosen: Record<string, string> = {}
  const missing: string[] = []

  for (const [name, values] of Object.entries(dimensions)) {
    const hit = values.find((v) => wordSet.has(v))
    if (hit === undefined) missing.push(name)
    else chosen[name] = hit
  }

  // A number that is not one of this post's dimension values can only be a
  // count. "hitam 38 2pcs" therefore reads as size 38, quantity 2 — the size is
  // claimed by the size dimension before quantity ever looks at the digits.
  const dimensionValues = new Set(Object.values(dimensions).flat())
  const claimedValues = new Set(Object.values(chosen))
  let quantity = 1
  for (const word of words) {
    const match = word.match(/^(\d+)(?:pcs|pc|x)?$/)
    if (!match) continue
    const n = Number(match[1])
    if (dimensionValues.has(match[1]) && !claimedValues.has(match[1])) continue
    if (dimensionValues.has(match[1]) && claimedValues.has(match[1])) continue
    if (n > 0 && n < 100) quantity = n
  }
  // "x2" and "2x" both appear; the bare-number rule above misses the leading x.
  const explicit = text.toLowerCase().match(/x\s*(\d+)|(\d+)\s*(?:pcs|pc|buah)/)
  if (explicit) quantity = Number(explicit[1] ?? explicit[2])

  const variantId =
    missing.length === 0
      ? (variants.find((v) =>
          Object.entries(chosen).every(([k, val]) => v.dimensions[k] === val),
        )?.id ?? null)
      : null

  return {
    variantId,
    quantity,
    missing,
    candidates: missing.length > 0 ? [...dimensions[missing[0]]] : [],
  }
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npm test`
Expected: PASS, 28 tests total.

- [ ] **Step 5: Commit**

```bash
git add lib/claims/text.ts lib/claims/text.test.ts
git commit -m "feat(claims): resolve text claims against a post's declared variants

Matching against fifteen known options is a far smaller problem than parsing
Indonesian in the open, which is why the caption stays human and no per-variant
short codes are asked of customers.

An incomplete claim reports which dimension is missing and what the options are,
so the owner can ask 'warna apa kak?' with the answers already to hand. A number
that is not one of the post's own dimension values can only be a count, so
'hitam 38 2pcs' reads as size 38, quantity 2."
```

---

### Task 7: Classifying answers to substitution questions

When the owner offers a substitute, the customer answers with words or with a reaction. Both resolve here.

**Files:**
- Create: `lib/claims/answer.ts`
- Test: `lib/claims/answer.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type Verdict = "accept" | "decline" | "unclear"`
  - `classifyAnswer(input: { text?: string; emoji?: string }): Verdict`

- [ ] **Step 1: Write the failing tests**

Create `lib/claims/answer.test.ts`:

```typescript
import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyAnswer } from "./answer"

test("accepts the ordinary Indonesian yeses", () => {
  for (const text of ["ok", "oke", "boleh", "gpp", "ga papa", "mau", "iya", "yaudah", "lanjut"]) {
    assert.equal(classifyAnswer({ text }), "accept", `expected accept for "${text}"`)
  }
})

test("declines the ordinary Indonesian noes", () => {
  for (const text of ["ga jadi", "gajadi", "ga usah", "engga", "skip", "batal", "no"]) {
    assert.equal(classifyAnswer({ text }), "decline", `expected decline for "${text}"`)
  }
})

test("a negated yes is a decline, not an accept", () => {
  // "ga mau" contains "mau"; substring matching would get this backwards.
  assert.equal(classifyAnswer({ text: "ga mau" }), "decline")
  assert.equal(classifyAnswer({ text: "gak boleh" }), "decline")
})

test("reads approving and rejecting reactions", () => {
  for (const emoji of ["\u{1F44D}", "\u{1F44C}", "❤️", "✅"]) {
    assert.equal(classifyAnswer({ emoji }), "accept", `expected accept for ${emoji}`)
  }
  for (const emoji of ["\u{1F44E}", "❌"]) {
    assert.equal(classifyAnswer({ emoji }), "decline", `expected decline for ${emoji}`)
  }
})

test("an unrecognised reaction is unclear rather than assumed", () => {
  // Customers do react to the wrong message; guessing would silently corrupt a claim.
  assert.equal(classifyAnswer({ emoji: "\u{1F602}" }), "unclear")
})

test("anything unrecognisable is unclear", () => {
  assert.equal(classifyAnswer({ text: "kalau 95 muat ga ya?" }), "unclear")
  assert.equal(classifyAnswer({}), "unclear")
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./answer`.

- [ ] **Step 3: Implement**

Create `lib/claims/answer.ts`:

```typescript
export type Verdict = "accept" | "decline" | "unclear"

/**
 * Reactions carry the exact message they were applied to, which makes them the
 * most reliable answer channel — no quote chain to walk, no text to parse.
 */
const ACCEPT_EMOJI = new Set(["\u{1F44D}", "\u{1F44C}", "❤️", "❤", "✅", "\u{1F64F}"])
const DECLINE_EMOJI = new Set(["\u{1F44E}", "❌", "\u{1F645}"])

const ACCEPT_WORDS = [
  "ok", "oke", "okay", "boleh", "gpp", "ga papa", "gapapa", "gak papa",
  "mau", "iya", "ya", "yaudah", "yuk", "lanjut", "ambil", "deal", "sip",
]

const DECLINE_WORDS = [
  "ga jadi", "gajadi", "gak jadi", "ga usah", "gausah", "engga", "enggak",
  "ga", "gak", "nggak", "tidak", "skip", "batal", "cancel", "no", "pass",
]

/**
 * Normalize to bare words so matching can be word-exact.
 *
 * Substring matching is what gets this wrong: "ga mau" contains "mau", and
 * reading that as a yes would buy something the customer just refused.
 */
function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean)
}

function hasPhrase(list: string[], tokens: string[]): boolean {
  const joined = ` ${tokens.join(" ")} `
  return list.some((phrase) => joined.includes(` ${phrase} `))
}

/**
 * Decide what a customer's answer to a substitution offer means.
 *
 * Unclear is a real outcome, not a failure: it sends the claim to review, where
 * the owner reads the message themselves. Guessing would silently change what
 * someone is charged for.
 */
export function classifyAnswer(input: { text?: string; emoji?: string }): Verdict {
  if (input.emoji !== undefined) {
    if (ACCEPT_EMOJI.has(input.emoji)) return "accept"
    if (DECLINE_EMOJI.has(input.emoji)) return "decline"
    return "unclear"
  }

  if (input.text === undefined) return "unclear"
  const tokens = words(input.text)
  if (tokens.length === 0) return "unclear"

  // Decline is tested first, and deliberately: negations are built by putting a
  // "ga" in front of a positive word, so a text containing both is a refusal.
  if (hasPhrase(DECLINE_WORDS, tokens)) return "decline"
  if (hasPhrase(ACCEPT_WORDS, tokens)) return "accept"
  return "unclear"
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npm test`
Expected: PASS, 34 tests total.

- [ ] **Step 5: Commit**

```bash
git add lib/claims/answer.ts lib/claims/answer.test.ts
git commit -m "feat(claims): classify substitution answers from text or reaction

Decline is tested before accept because Indonesian negation is built by putting
a 'ga' in front of a positive word — 'ga mau' contains 'mau', and reading that
as a yes would buy something the customer just refused. Matching is word-exact
for the same reason.

Unclear is a real outcome rather than a failure: it routes to review, where the
owner reads the message themselves. Guessing would silently change what someone
is charged for."
```

---

### Task 8: Clustering marks into slots

Several customers marking the same item produce several nearby points. Turning those into one slot with a count is what makes the shopping list a shopping list.

**Files:**
- Create: `lib/claims/cluster.ts`
- Test: `lib/claims/cluster.test.ts`

**Interfaces:**
- Consumes: `Point` (Task 4).
- Produces:
  - `interface Cluster { centre: Point; members: number[] }` — `members` are indices into the input array.
  - `clusterPoints(points: Point[], radius?: number): Cluster[]` — sorted by member count descending.
  - `DEFAULT_CLUSTER_RADIUS = 0.06`

- [ ] **Step 1: Write the failing tests**

Create `lib/claims/cluster.test.ts`:

```typescript
import { test } from "node:test"
import assert from "node:assert/strict"
import { clusterPoints, DEFAULT_CLUSTER_RADIUS } from "./cluster"

test("marks on the same item become one slot", () => {
  const clusters = clusterPoints([
    { x: 0.24, y: 0.78 },
    { x: 0.25, y: 0.79 },
    { x: 0.243, y: 0.775 },
  ])
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].members.length, 3)
  assert.ok(Math.abs(clusters[0].centre.x - 0.244) < 0.01)
})

test("marks on different items stay apart", () => {
  const clusters = clusterPoints([
    { x: 0.24, y: 0.78 },
    { x: 0.41, y: 0.77 },
  ])
  assert.equal(clusters.length, 2)
})

test("busiest slot comes first", () => {
  const clusters = clusterPoints([
    { x: 0.80, y: 0.20 },
    { x: 0.24, y: 0.78 },
    { x: 0.25, y: 0.78 },
    { x: 0.245, y: 0.785 },
  ])
  assert.equal(clusters[0].members.length, 3)
  assert.equal(clusters[1].members.length, 1)
})

test("members point back at the claims that formed the slot", () => {
  const clusters = clusterPoints([
    { x: 0.80, y: 0.20 },
    { x: 0.24, y: 0.78 },
    { x: 0.25, y: 0.78 },
  ])
  const busiest = clusters[0]
  assert.deepEqual([...busiest.members].sort(), [1, 2])
})

test("a chain of marks does not merge distant items", () => {
  // Points a hair under the radius apart, stepping across the frame. Naive
  // transitive grouping would swallow the whole row into one slot.
  const points = Array.from({ length: 8 }, (_, i) => ({ x: 0.1 + i * 0.05, y: 0.5 }))
  const clusters = clusterPoints(points)
  assert.ok(clusters.length > 1, `expected several slots, got ${clusters.length}`)
})

test("no points, no slots", () => {
  assert.deepEqual(clusterPoints([]), [])
})

test("the default radius is exported for callers that tune it", () => {
  assert.equal(DEFAULT_CLUSTER_RADIUS, 0.06)
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./cluster`.

- [ ] **Step 3: Implement**

Create `lib/claims/cluster.ts`:

```typescript
import type { Point } from "./ink"

export interface Cluster {
  centre: Point
  /** Indices into the array passed to clusterPoints. */
  members: number[]
}

/**
 * How close two marks must be to mean the same item, in normalized units.
 *
 * Roughly a tenth of the frame's shorter side: wide enough that two people
 * ticking the same pyjama set agree, narrow enough that neighbouring items on a
 * packed shelf stay apart. Shelves vary, so callers may override it — and the
 * annotated photo is where a wrong choice becomes visible and correctable.
 */
export const DEFAULT_CLUSTER_RADIUS = 0.06

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * Group claim positions into slots.
 *
 * Leader-based rather than transitive: each cluster is anchored to a seed point
 * and only admits points within the radius OF THAT SEED. Transitive grouping —
 * where A joins B, B joins C, so A and C share a slot — chains along a row of
 * evenly-spaced items and swallows the whole shelf into one slot.
 *
 * Seeds are taken in input order, and callers pass marks largest-first, so the
 * most confident mark anchors each slot.
 */
export function clusterPoints(points: Point[], radius = DEFAULT_CLUSTER_RADIUS): Cluster[] {
  const taken = new Array<boolean>(points.length).fill(false)
  const clusters: Cluster[] = []

  for (let i = 0; i < points.length; i++) {
    if (taken[i]) continue
    taken[i] = true
    const members = [i]

    for (let j = i + 1; j < points.length; j++) {
      if (taken[j]) continue
      if (distance(points[i], points[j]) <= radius) {
        taken[j] = true
        members.push(j)
      }
    }

    let sumX = 0
    let sumY = 0
    for (const m of members) {
      sumX += points[m].x
      sumY += points[m].y
    }

    clusters.push({
      centre: { x: sumX / members.length, y: sumY / members.length },
      members,
    })
  }

  return clusters.sort((a, b) => b.members.length - a.members.length)
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npm test`
Expected: PASS, 41 tests total.

- [ ] **Step 5: Commit**

```bash
git add lib/claims/cluster.ts lib/claims/cluster.test.ts
git commit -m "feat(claims): cluster marks into slots

Leader-based rather than transitive. Transitive grouping — A joins B, B joins C,
so A and C share a slot — chains along a row of evenly-spaced items and swallows
a whole shelf into one slot; a test pins that behaviour so nobody reintroduces
it while 'simplifying'.

Seeds are taken in input order and callers pass marks largest-first, so the most
confident mark anchors each slot."
```

---

### Task 9: The public entry point

One module the rest of the app imports, so the dashboard and the worker never reach into individual resolver files.

**Files:**
- Create: `lib/claims/index.ts`
- Test: `lib/claims/index.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `resolveImageReply(postPath: string, replyPath: string): Promise<ImageReply>` plus re-exports of every type and resolver.
  - `type ImageReply = { kind: "marks"; marks: Mark[] } | { kind: "crop"; located: Located } | { kind: "repost"; located: Located } | { kind: "unresolved" }`

- [ ] **Step 1: Write the failing tests**

Create `lib/claims/index.test.ts`:

```typescript
import { test } from "node:test"
import assert from "node:assert/strict"
import { FIXTURES } from "./fixtures"
import { resolveImageReply } from "./index"

test("a marked reply resolves to its marks", async () => {
  const result = await resolveImageReply(FIXTURES.original, FIXTURES.ticked)
  assert.equal(result.kind, "marks")
  if (result.kind !== "marks") return
  assert.equal(result.marks.length, 2)
})

test("a cropped reply resolves to a located region", async () => {
  const result = await resolveImageReply(FIXTURES.original, FIXTURES.crop)
  assert.equal(result.kind, "crop")
  if (result.kind !== "crop") return
  assert.ok(result.located.score > 0.85)
})

test("ink wins over location when a reply has both", async () => {
  // ticked.jpg is the whole frame AND carries marks. The marks are the claim;
  // the fact that it also matches the post as a repost is not interesting.
  const result = await resolveImageReply(FIXTURES.original, FIXTURES.ticked)
  assert.equal(result.kind, "marks")
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Implement**

Create `lib/claims/index.ts`:

```typescript
import { loadRgb } from "./raster"
import { hueHistogram, safePenHues } from "./hue"
import { detectMarks, type Mark } from "./ink"
import { locateInPost, type Located } from "./locate"

export { loadRgb, loadGray, rgbToHsv, type RgbRaster, type GrayRaster } from "./raster"
export { hueHistogram, safePenHues, PEN_COLOURS, HUE_BUCKETS } from "./hue"
export { detectMarks, type Mark, type Point } from "./ink"
export { locateInPost, type Located, type Region } from "./locate"
export { parseVariantNote, resolveText, type Variant, type TextClaim } from "./text"
export { classifyAnswer, type Verdict } from "./answer"
export { clusterPoints, DEFAULT_CLUSTER_RADIUS, type Cluster } from "./cluster"

export type ImageReply =
  | { kind: "marks"; marks: Mark[] }
  | { kind: "crop"; located: Located }
  | { kind: "repost"; located: Located }
  | { kind: "unresolved" }

/** Working width for mark detection. Strokes are large; detail is not needed. */
const REPLY_W = 480
/** Working width for the histogram. Only proportions matter here. */
const POST_W = 240

/**
 * Decide what an image reply is claiming.
 *
 * Ink is tested first because a marked photo is unambiguous: the customer
 * pointed at something. A reply with marks is usually also a whole-frame match
 * against the post, and reporting that instead would throw away the only part
 * that says WHICH item.
 *
 * Trusted hues come from the post itself — see safePenHues. Passing a hue the
 * photo contains would return the photo's own contents as marks.
 */
export async function resolveImageReply(
  postPath: string,
  replyPath: string,
): Promise<ImageReply> {
  const post = await loadRgb(postPath, POST_W)
  const hues = safePenHues(hueHistogram(post), post.width * post.height).map((c) => c.hue)

  const reply = await loadRgb(replyPath, REPLY_W)
  const marks = detectMarks(reply, hues)
  if (marks.length > 0) return { kind: "marks", marks }

  const located = await locateInPost(postPath, replyPath)
  if (located === null) return { kind: "unresolved" }
  return located.kind === "repost" ? { kind: "repost", located } : { kind: "crop", located }
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npm test`
Expected: PASS, 44 tests total.

- [ ] **Step 5: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add lib/claims/index.ts lib/claims/index.test.ts
git commit -m "feat(claims): single entry point for the resolver library

Ink is tested before location because a marked photo is unambiguous — the
customer pointed at something. A marked reply is usually also a whole-frame
match against the post, and reporting that instead would discard the only part
that says which item.

Trusted hues come from the post itself, so a caller cannot accidentally ask for
marks in a colour the photograph is full of."
```

---

## What this plan does not build

Deliberately out of scope, each belonging to a later plan:

- **Database tables, review queue, shopping-list rendering, buy tally, order creation** — plan 2, the dashboard. This library returns positions and confidences; nothing here knows what a product is.
- **Baileys session, `/connect`, `/rekap`, reactions, throttling** — plan 3, the worker.
- **Numbered shelf photos.** The spec keeps numbering optional. If the first real event shows customers mostly typing rather than marking, numbering becomes required and gets its own task then.
