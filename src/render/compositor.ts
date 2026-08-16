// Per Contract 10 (subtask 12 in the countdown-timer-block master task), this
// is NOT a "frames to library" pipeline. It is a hand-rolled PER-FRAME
// BACKGROUND-AWARE PALETTE COMPOSITING LOOP. For every source pixel:
//
//   1. Look up the BACKGROUND frame's current palette index at that position
//   2. Alpha-blend the source RGBA over the bg's RGBA in RGBA space
//   3. Find the nearest palette entry by sum-of-squared-differences
//   4. Cache the result keyed by `(source RGBA, bg RGBA)` to avoid repeating
//      the nearest-color search
//
// A naive port that composites in RGBA then re-quantizes per frame produces
// visibly worse output (worse dithering, ~30% larger files, color drift).
// DO NOT take the shortcut.
//
// ## Frame model (critical) — reference model, blank base + full digit frames
//
// The digit sprites are sliced from digits.png into FRESH 0-based buffers and
// drawn anchored at their destination slot rect (NOT at a sheet coordinate —
// see clipDrawRect).
//
//   - GIF frame 0 is the BLANK board — the captured board.png has empty digit
//     slots (the capture paints its "00" placeholders `color:transparent`), so
//     this frame carries NO digits. `dispose: 1` (DO NOT DISPOSE) keeps it as
//     the persistent base every later frame composites over / restores to. When
//     the board itself is TRANSPARENT (`boardBackground: 'transparent'`, captured
//     with `omitBackground: true`), its transparent regions quantize to
//     `TRANSPARENT_SLOT` and frame 0 is written with the GIF transparency flag so
//     the email background shows through there (`boardHasTransparency`); an opaque
//     board has no slot-0 pixels, so the flag stays off and its bytes are unchanged.
//   - Frames 1..N (one per remaining second) are FULL digit frames: a fresh
//     transparent frame with ALL FOUR slots' digits composited over the blank
//     board, the rest transparent. `dispose: 3` (RESTORE PREVIOUS) wipes each
//     frame's digits back to the blank board before the next frame draws, so no
//     second's digits can ghost into the next. Because the base is blank, there
//     is NOTHING to ghost from — the earlier "baked-digit frame 0 + accumulate"
//     model left marks when a narrower digit failed to fully cover a wider one.
//
// Digit sprites are captured on a TRANSPARENT background. Where a sprite
// pixel is transparent, `drawPaletted` blends
// it over the board `bg`, so each digit rect's background resolves to the board
// color — invisible against the board (no white box), and the glyph paints in
// the digit color.
//
// The Outlook PNG fallback (`pngBytes`) is NOT the blank frame 0 — it is a
// SEPARATE composite of the board + the CURRENT second's digits, so Outlook
// (which renders only the static PNG) still shows the right time.
//
// ## Library wiring
//
//   - gifenc 1.0.3: palette-mode GIF encoder. `writeFrame(indexPixels, w, h,
//     { palette, delay, transparent, transparentIndex, dispose })`.
//     `dispose: 1` (DO NOT DISPOSE) keeps frame 0 as the base; `dispose: 3`
//     (RESTORE PREVIOUS) resets each digit frame to the blank board. gifenc's
//     README documents only dispose -1/2, but the source masks `dispose & 7`
//     so 3 encodes correctly. `delay` is in milliseconds (NOT centiseconds
//     like Go's image/gif).
//   - pngjs 7.0.0: `PNG.sync.read(Buffer) -> { width, height, data }`. The
//     `data` field is a Node Buffer of RGBA bytes (4 per pixel).

// gifenc 1.0.3 ships two builds: CJS (`dist/gifenc.js`, picked via "main")
// and ESM (`dist/gifenc.esm.js`, picked via "module"). Node — with no
// `"exports"` map in gifenc's package.json — uses "main" and loads the CJS
// build, whose interop shape does NOT expose `GIFEncoder` as a named export
// (`SyntaxError: ... does not provide an export named 'GIFEncoder'`).
// Vitest/Vite prefers "module" and loads the ESM build, which DOES.
//
// Importing the ESM build by its explicit deep path sidesteps the ambiguity
// in both runtimes. See `gifenc.d.ts` for the typed surface.
import { GIFEncoder } from 'gifenc/dist/gifenc.esm.js';
import { PNG } from 'pngjs';
import { PLAN9_PALETTE } from './plan9-palette.js';

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Decoded capture PNG (board or digits). Produced by `decodePng` in
 * `storage.ts`. Per-pixel RGBA read shape consumed by the compositing loop.
 */
export interface RasterImage {
  readonly rgba: Uint8Array; // length = width * height * 4, layout [r, g, b, a] per pixel
  readonly width: number;
  readonly height: number;
}

/**
 * Per-element bounding box captured by the Puppeteer capture pass.
 *
 * Coordinates are in CAPTURE SPACE (the PNG's pixel coordinate system), NOT
 * the board's local space. Both `board` and `digits` PNGs are captured
 * against the same browser page, so per-digit boxes inside `digits.png` and
 * per-slot boxes inside `board.png` use a shared origin.
 */
export interface BoundingBox {
  readonly key: string; // e.g. "board-days", "digits-5"
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The three brand colors captured into the countdown design. The renderer
 * merges these INTO the base palette (replacing the nearest Plan9 entry for
 * each) so the output GIF uses the user's actual brand colors, not approximations.
 *
 * Matches `CountdownColors` in countdown-timers.table.ts (Contract 2 inputs).
 */
export interface CountdownColors {
  readonly digit: string;
  readonly board: string;
  readonly border: string;
}

/**
 * Output of a render call. `gifBytes` is the full GIF89a stream (frame 0 =
 * blank board base + frames 1..N = per-second digit frames, DISPOSAL_PREVIOUS).
 * `pngBytes` is a SEPARATE board + current-digits composite re-encoded as PNG
 * — the Outlook fallback (NOT the blank frame 0).
 */
export interface RenderedArtifacts {
  readonly gifBytes: Uint8Array;
  readonly pngBytes: Uint8Array;
}

// ─── Constants ────────────────────────────────────────────────────────────

/** Total overlay frames to draw. */
const FRAME_COUNT = 30;

/** Plan9-minus-last-entry length — the renderer skips Plan9[255]. */
const PLAN9_USED_LENGTH = PLAN9_PALETTE.length - 1;

/**
 * Total palette size — 1 transparent slot + (Plan9 - 1) = 256, the GIF max.
 *
 * Slot 0 is the transparent slot. Overlay frames use slot 0 as their
 * `transparentIndex` so non-overlapping pixels do not overwrite the
 * background.
 */
const PALETTE_SIZE = 1 + PLAN9_USED_LENGTH;

/** Slot reserved as the transparent palette entry on every frame's color table. */
const TRANSPARENT_SLOT = 0;

/** Board sub-element name keys (data-integration attribute minus the `countdown-` prefix). */
const BOARD_KEY = 'board';
const DIGITS_KEY = 'digits';

/**
 * Normalize the box arrays produced by the capture pre-pass into the key
 * shape the renderer expects.
 *
 * The capture pre-pass writes BARE keys —
 * `"days"/"hours"/"minutes"/"seconds"` for board units and
 * `"0".."9"` for digit sprites — because `extractKey` strips the
 * `countdown-board-` / `countdown-digits-` prefix before persisting. The
 * renderer, however, looks up slots by PREFIXED keys (`"board-days"`,
 * `"digits-3"`, …) and expects a synthetic `"board"` / `"digits"` parent box
 * describing the full captured region.
 *
 * This helper bridges the two: it rewrites bare keys to their prefixed form
 * and synthesizes the parent `"board"` / `"digits"` box as the FULL captured
 * image `(0, 0, imageWidth, imageHeight)`. That origin (0,0) is exactly what
 * the child boxes are measured against, so digit placement lines up with the
 * board's baked placeholder glyphs. Both bare and already-prefixed inputs are
 * accepted, so the renderer is resilient to either capture format.
 */
function normalizeBoxes(
  boxes: ReadonlyArray<BoundingBox>,
  prefix: string,
  childKeys: ReadonlyArray<string>,
  imageWidth: number,
  imageHeight: number,
): Map<string, BoundingBox> {
  const out = new Map<string, BoundingBox>();

  // Index children by their normalized (prefixed) key.
  for (const box of boxes) {
    const bare = box.key.startsWith(`${prefix}-`) ? box.key.slice(prefix.length + 1) : box.key;
    if (!childKeys.includes(bare)) continue;
    const key = `${prefix}-${bare}`;
    out.set(key, { ...box, key });
  }

  // The parent box is the FULL captured image, whose origin (0,0) matches the
  // origin the child boxes are measured against. Using the child-box UNION here
  // (the old behavior) shifted the origin to the first child — e.g. a board with
  // 10px left padding placed every digit 10px off from the board's baked
  // placeholder glyphs. The image extent is the correct, un-shifted parent.
  out.set(prefix, { key: prefix, x: 0, y: 0, width: imageWidth, height: imageHeight });

  return out;
}

/** Frame timing in gifenc — milliseconds, NOT centiseconds (see subtask 11 caveat #2). */
const OVERLAY_FRAME_DELAY_MS = 1000; // 1 fps

/**
 * Delay (ms) for the blank base frame (and the single expired frame). `0` so
 * the blank board is shown imperceptibly — animating clients jump straight to
 * the first digit frame; the base exists only as the disposal target + the
 * frozen-frame fallback.
 */
const BASE_FRAME_DELAY_MS = 0;

/** GIF disposal method 1 — DO NOT DISPOSE (leave the frame in place). */
const DISPOSAL_NONE = 1;

/** GIF disposal method 3 — RESTORE PREVIOUS (reset the frame's region to what was there before it). */
const DISPOSAL_PREVIOUS = 3;

// ─── Internal types ─────────────────────────────────────────────────────────

/**
 * A palette entry as 8-bit RGBA. We work in 8-bit space throughout — pngjs
 * returns 8-bit channels, gifenc writes 8-bit palette slots, and the
 * nearest-color math (sum of squared differences) is scale-invariant.
 */
type Rgba = readonly [number, number, number, number];

/**
 * The renderer's working palette: a 256-entry table of RGBA values plus a
 * per-render cache for the nearest-color search.
 *
 * The cache is the key optimization. Without it, every pixel of every
 * frame would re-scan all 256 palette entries (~64K ops per frame). The
 * cache keys on `(source RGBA, background RGBA)` because the blended
 * color depends on BOTH — pixels with the same source color but
 * different background colors can blend to different palette entries.
 */
interface RenderPalette {
  readonly rgba: Rgba[]; // length = PALETTE_SIZE (256)
  readonly cache: Map<number, number>; // cacheKey to palette slot index
}

/** A 2D rect in capture-space pixel coordinates. */
interface Rect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Working bitmap: palette slot indices + width + height. */
interface PalettedFrame {
  readonly pix: Uint8Array; // length = width * height, values are palette slot indices
  readonly stride: number; // bytes per row (== width for tightly packed frames)
  readonly width: number;
  readonly height: number;
}

/** Per-place digit lookup: e.g. { "board-days": ["digits-5", "digits-3"], ... }. */
type TimeDigits = Readonly<Record<string, readonly [string, string]>>;

// ─── Color parsing ──────────────────────────────────────────────────────────

/**
 * Parse `#RRGGBB` or `RRGGBB` into `[r, g, b, 255]` (8-bit per channel, opaque).
 *
 * Invalid hex strings are rejected with a thrown Error — `schema.ts`
 * pre-validates at the HTTP boundary so by the time we get here the colors
 * are sanitized, but defensive parsing here keeps the renderer pure and
 * self-contained.
 */
function parseHex(hex: string): Rgba {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  if (clean.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return [r, g, b, 255];
}

// ─── Pixel math (sqDiff + nearest-color search) ────────────────────────────

/**
 * Sum-of-squared-differences across all 4 RGBA channels.
 *
 * Go's `sqDiff(x, y int32) uint32` uses the trick `(x-y)*(x-y) >> 2` to avoid
 * uint32 overflow when summing four 16-bit channels. In 8-bit space (max diff
 * 255 squared = 65025 per channel, sum ≤ 260100) we don't need the shift —
 * the sum fits comfortably in a JS number (which is a 64-bit double).
 */
function sqDiffAll(a: Rgba, b: Rgba): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  const da = a[3] - b[3];
  return dr * dr + dg * dg + db * db + da * da;
}

// ─── Palette construction ──────────────────────────────────────────────────

/**
 * Build the 256-entry working palette by starting from
 * `[transparent, ...Plan9[0..254]]` and replacing the nearest Plan9 entry
 * for each of the three brand colors (digit / board / border).
 *
 * The replacement strategy matches Go's `getColorPalette` exactly: for each
 * input color, find the closest entry in the current palette (by sum of
 * squared RGBA differences), then OVERWRITE that slot with the input color.
 * Subsequent colors search the modified palette, so a later color can
 * replace a different slot than an earlier one. This greedily minimizes
 * disruption to the rest of the palette.
 *
 * Brand colors are applied in deterministic order (digit, board, border) so
 * the same inputs always produce the same palette — important for cache
 * hit-ratio and reproducible renders.
 */
function buildPalette(colors: CountdownColors): RenderPalette {
  // Start with [transparent, ...Plan9[0..254]].
  const rgba: Rgba[] = new Array<Rgba>(PALETTE_SIZE);
  rgba[TRANSPARENT_SLOT] = [0, 0, 0, 0]; // alpha=0 transparent
  for (let i = 0; i < PLAN9_USED_LENGTH; i++) {
    const [r, g, b] = PLAN9_PALETTE[i];
    rgba[i + 1] = [r, g, b, 255];
  }

  // Replace the nearest entry for each brand color (fixed order: digit, board, border).
  const order: readonly string[] = [colors.digit, colors.board, colors.border];
  for (const hex of order) {
    const source = parseHex(hex);

    let bestIndex = 0;
    let bestSum = Number.POSITIVE_INFINITY;
    for (let i = 0; i < rgba.length; i++) {
      const sum = sqDiffAll(source, rgba[i]);
      if (sum < bestSum) {
        bestIndex = i;
        bestSum = sum;
        if (sum === 0) break; // exact match, can't do better
      }
    }
    rgba[bestIndex] = source;
  }

  return { rgba, cache: new Map() };
}

// ─── Source pixel reading ───────────────────────────────────────────────────

/** Return a copy of `src` cropped to `rect`. Used to extract individual digit sprites. */
function sliceRaster(src: RasterImage, rect: Rect): RasterImage {
  const minX = Math.max(0, rect.minX);
  const minY = Math.max(0, rect.minY);
  const maxX = Math.min(src.width, rect.maxX);
  const maxY = Math.min(src.height, rect.maxY);
  const w = Math.max(0, maxX - minX);
  const h = Math.max(0, maxY - minY);

  // Copy the sub-rect into its own buffer — simpler than a stride-aware view,
  // and digit sprites are small (~30x50 px each) so the copy is cheap.
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRow = ((minY + y) * src.width + minX) * 4;
    const dstRow = y * w * 4;
    rgba.set(src.rgba.subarray(srcRow, srcRow + w * 4), dstRow);
  }
  return { rgba, width: w, height: h };
}

// ─── The compositing loop ──────────────────────────────────────────────────

/**
 * Clip `rect` to both the destination frame's bounds and the source sprite's
 * extent. The source is a 0-based RGBA buffer (produced by `sliceRaster`) drawn
 * so its pixel (0,0) lands at the destination `(rect.minX, rect.minY)`. So the
 * source covers destination pixels `[rect.minX, rect.minX + src.width) ×
 * [rect.minY, rect.minY + src.height)`.
 *
 * IMPORTANT: the source is a 0-based buffer, NOT a sheet sub-image. Each
 * glyph is copied into a fresh 0-based buffer via `sliceRaster`, so the
 * source origin is `(0,0)` and the anchor is the destination rect origin.
 * Intersecting the destination rect with the glyph's SHEET extent (the
 * earlier approach) almost never overlapped the on-board slot, so digits
 * were clipped away (or read shifted rows) and the countdown never
 * rendered correctly.
 *
 * Returns the clipped destination rect, or `null` if empty. The caller still
 * indexes the source by `(x - rect.minX, y - rect.minY)` using the ORIGINAL
 * (pre-clip) `rect` origin, so a negative origin (a wide tens digit whose
 * `firstDelta < 0` pushes it left of the slot) samples the correct source
 * column even after the left edge is clipped to 0.
 */
function clipDrawRect(dstWidth: number, dstHeight: number, rect: Rect, src: RasterImage): Rect | null {
  const minX = Math.max(rect.minX, 0);
  const minY = Math.max(rect.minY, 0);
  const maxX = Math.min(rect.maxX, dstWidth, rect.minX + src.width);
  const maxY = Math.min(rect.maxY, dstHeight, rect.minY + src.height);

  if (minX >= maxX || minY >= maxY) return null;

  return { minX, minY, maxX, maxY };
}

/** Transparent RGBA constant — fallback for missing palette slots (defensive). */
const TRANSPARENT_RGBA: Rgba = [0, 0, 0, 0];

/**
 * Composite a 0-based `src` sprite onto `dst` at `rect`, using `bg` as the
 * background reference for the alpha-blend + nearest-color search. `src` is
 * drawn so its pixel (0,0) lands at `(rect.minX, rect.minY)` — the destination
 * anchor, NOT a sheet coordinate (see `clipDrawRect`).
 *
 * For every destination pixel in the (clipped) rect:
 *
 *   1. Read source RGBA at (x - rect.minX, y - rect.minY) from the 0-based src.
 *   2. Read the BACKGROUND frame's current palette slot at (x, y), then
 *      look up its RGBA in the palette table.
 *   3. Check the per-render cache for `(src RGBA, bg RGBA)` — if hit, reuse.
 *   4. On miss: alpha-blend src over bg, find nearest palette slot, cache.
 *   5. Write the resolved slot index to dst at (x, y).
 *
 * `bg` is the frame the sprite visually sits on for anti-alias blending — the
 * board frame for digit overlays; for quantizing the board PNG itself,
 * `bg === dst === src`-target so reads see the just-written state (Phase 4,
 * `drawPaletted(boardFrame, boardFrame, {0..W,0..H}, board, ...)`).
 *
 * The cache lives on `palette.cache` for the lifetime of one render call
 * (~30 frames), so identical (src, bg) pairs across frames resolve in O(1).
 * This is the optimization that makes the faithful port tractable in JS —
 * without it, every pixel of every frame would scan all 256 palette entries.
 */
function drawPaletted(
  bg: PalettedFrame,
  dst: PalettedFrame,
  rect: Rect,
  src: RasterImage,
  palette: RenderPalette,
  skipTransparent = false,
): void {
  const clipped = clipDrawRect(dst.width, dst.height, rect, src);
  if (!clipped) return;

  const c = clipped;
  const src32PerPixel = 4; // RGBA
  const rgba = palette.rgba;
  const cache = palette.cache;

  for (let y = c.minY; y < c.maxY; y++) {
    const dstRowStart = y * dst.stride;
    const bgRowStart = y * bg.stride;
    // Source is 0-based and anchored at the ORIGINAL rect origin, so the source
    // row/col are relative to rect.minY/minX (which may be negative — the clip
    // shifted c.minX/minY to 0 but the source math must use the original).
    const srcRowBase = (y - rect.minY) * src.width * src32PerPixel;

    for (let x = c.minX; x < c.maxX; x++) {
      const srcOffset = srcRowBase + (x - rect.minX) * src32PerPixel;
      const srcR = src.rgba[srcOffset];
      const srcG = src.rgba[srcOffset + 1];
      const srcB = src.rgba[srcOffset + 2];
      const srcA = src.rgba[srcOffset + 3];

      // Digit overlays pass `skipTransparent`: a fully-transparent source pixel
      // leaves `dst` untouched instead of resolving to the background slot. This
      // matters ONLY for the TWO-WIDTH scheme, where padded tens/ones sprites
      // OVERLAP at the slot seam — without the skip, the second sprite's
      // transparent padding would blend-to-background and overwrite (erase) the
      // first sprite's ink edge there. For non-overlapping sprites the visual is
      // unchanged (a transparent pixel over the board resolves to the board slot
      // anyway; leaving it as the frame's transparent slot shows the same board
      // through the GIF's transparent index). Board quantization (Phase 4) passes
      // the default `false` — the opaque board has no transparent pixels, so its
      // bytes are unaffected.
      if (skipTransparent && srcA === 0) continue;

      // Prefer whatever `dst` already holds at this pixel (e.g. the tens digit's
      // ink, painted by an earlier call in the same `drawDigitFrames` pass) over
      // the static `bg` reference — a still-untouched `dst` pixel reads as
      // TRANSPARENT_SLOT (either genuinely unwritten, or a `bg` that's ALSO
      // transparent there), in which case falling back to `bg` reproduces the
      // original behavior exactly. Without this, a semi-transparent sprite edge
      // in the two-width overlap zone blends against the raw board color and
      // erases whatever ink the previous sprite already drew there.
      const dstSlotSoFar = dst.pix[dstRowStart + x];
      const bgSlot = dstSlotSoFar !== TRANSPARENT_SLOT ? dstSlotSoFar : bg.pix[bgRowStart + x];
      const bgRgba = rgba[bgSlot] ?? TRANSPARENT_RGBA;
      const bgR = bgRgba[0];
      const bgG = bgRgba[1];
      const bgB = bgRgba[2];
      const bgA = bgRgba[3];

      // Compute cache key inline (same packing as cacheKey() but without
      // tuple allocation — the hot loop must avoid GC pressure).
      const src32 = (((srcR << 24) >>> 0) | (srcG << 16) | (srcB << 8) | srcA) >>> 0;
      const bg32 = (((bgR << 24) >>> 0) | (bgG << 16) | (bgB << 8) | bgA) >>> 0;
      const key = src32 * 0x100000000 + bg32;

      const cached = cache.get(key);
      let bestIndex: number;
      if (cached !== undefined) {
        bestIndex = cached;
      } else {
        // Alpha-blend src over bg in RGBA space.
        let er = srcR;
        let eg = srcG;
        let eb = srcB;
        let ea = srcA;
        if (ea < 255) {
          const a = 255 - ea;
          er = er + Math.round((bgR * a) / 255);
          eg = eg + Math.round((bgG * a) / 255);
          eb = eb + Math.round((bgB * a) / 255);
          ea = ea + Math.round((bgA * a) / 255);
        }

        // Nearest-color search.
        bestIndex = 0;
        let bestSum = Number.POSITIVE_INFINITY;
        for (let i = 0; i < rgba.length; i++) {
          const p = rgba[i];
          const dr = er - p[0];
          const dg = eg - p[1];
          const db = eb - p[2];
          const da = ea - p[3];
          const sum = dr * dr + dg * dg + db * db + da * da;
          if (sum < bestSum) {
            bestIndex = i;
            bestSum = sum;
            if (sum === 0) break;
          }
        }
        cache.set(key, bestIndex);
      }

      dst.pix[dstRowStart + x] = bestIndex;
    }
  }
}

// ─── Time fragments ────────────────────────────────────────────────────────

/** Convert a numeric time fragment (e.g. 53) to two digit keys: ["digits-5", "digits-3"]. */
function numberToDigitKeys(n: number): readonly [string, string] {
  const int = Math.floor(Math.max(0, n));
  const tens = Math.floor(int / 10) % 10;
  const ones = int % 10;
  return [`${DIGITS_KEY}-${tens}`, `${DIGITS_KEY}-${ones}`];
}

/**
 * Compute the 4 time fragments (days/hours/minutes/seconds) for a duration,
 * returning a map of `board-<unit>` -> [tensDigitKey, onesDigitKey].
 *
 * The day/hour/minute/second decomposition uses floor() so the values are
 * ALWAYS whole integers.
 */
function getTimeFragments(durMs: number): TimeDigits {
  let days = 0;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (durMs > 0) {
    const totalSec = durMs / 1000;
    days = Math.floor(totalSec / (60 * 60 * 24));
    hours = Math.floor(totalSec / (60 * 60) - days * 24);
    minutes = Math.floor(totalSec / 60 - days * 24 * 60 - hours * 60);
    seconds = Math.floor(totalSec - days * 60 * 60 * 24 - hours * 60 * 60 - minutes * 60);
  }

  return {
    [`${BOARD_KEY}-days`]: numberToDigitKeys(days),
    [`${BOARD_KEY}-hours`]: numberToDigitKeys(hours),
    [`${BOARD_KEY}-minutes`]: numberToDigitKeys(minutes),
    [`${BOARD_KEY}-seconds`]: numberToDigitKeys(seconds),
  };
}

/**
 * Build a lookup of `{ digitKey -> RasterImage }` for every digit referenced
 * across all frames, by sub-recting the digits.png capture.
 *
 * Sub-rects the digits.png by the digit's bounding box relative to the
 * parent `digits` box. We replicate that by slicing the same rect out of
 * the digits RGBA buffer (sliceRaster copies into a fresh buffer —
 * simpler than a view).
 */
function buildDigitImageCache(
  digitBoxes: ReadonlyMap<string, BoundingBox>,
  allDigitKeys: ReadonlySet<string>,
  digitsImage: RasterImage,
): Map<string, RasterImage> {
  const images = new Map<string, RasterImage>();

  const parentBox = digitBoxes.get(DIGITS_KEY);
  if (!parentBox) {
    return images;
  }

  for (const key of allDigitKeys) {
    if (images.has(key)) continue;
    const box = digitBoxes.get(key);
    if (!box) continue;

    // The glyph's position in digits.png (parentBox.x/y is the sheet origin).
    const relX = Math.round(box.x - parentBox.x);
    const relY = Math.round(box.y - parentBox.y);
    const w = Math.round(box.width);
    const h = Math.round(box.height);

    // Slice into a FRESH 0-based buffer. The draw path treats the result as
    // 0-based and anchors it at the destination slot (see drawPaletted).
    images.set(key, sliceRaster(digitsImage, { minX: relX, minY: relY, maxX: relX + w, maxY: relY + h }));
  }

  return images;
}

// ─── Digit frame composition ───────────────────────────────────────────────

/**
 * Compute the two destination rects (tens on the left half-slot, ones on the
 * right half-slot) for one time-unit slot, or `null` if the slot box or either
 * digit sprite is missing. Rects are in board-frame pixel coordinates; each
 * rect's width equals its digit sprite's width so `drawPaletted` maps the
 * 0-based sprite 1:1.
 *
 * Each sprite is CENTRED on its half-slot: `minX = halfStart + (halfW − spriteW)/2`.
 *   - When `spriteW === halfW` (monospaced digits with no capture padding) this
 *     is identical to the old "abut at slot centre" placement — tens fills the
 *     left half, ones the right.
 *   - When `spriteW > halfW` (the TWO-WIDTH scheme: digits captured with
 *     `DIGIT_SLICE_PADDING_X`, board unpadded so `halfW === advance`), the sprite
 *     is `advance + 2·pad` wide and centring puts the glyph's advance box exactly
 *     on the monospaced grid while its transparent padding — carrying the italic
 *     ink overhang — hangs `pad` past each side. Adjacent sprites therefore
 *     OVERLAP by `2·pad` at the seam; `drawDigitFrames` composites them with
 *     `skipTransparent` so the second sprite's transparent padding does not erase
 *     the first sprite's edge.
 */
function placeDigitRects(
  place: string,
  timeDigits: TimeDigits,
  boardBoxes: ReadonlyMap<string, BoundingBox>,
  digitImages: ReadonlyMap<string, RasterImage>,
): readonly [Rect, Rect] | null {
  const boardBox = boardBoxes.get(BOARD_KEY);
  const placeBox = boardBoxes.get(place);
  if (!boardBox || !placeBox) return null;

  const [tensKey, onesKey] = timeDigits[place];
  const tensImg = digitImages.get(tensKey);
  const onesImg = digitImages.get(onesKey);
  if (!tensImg || !onesImg) return null;

  const fx = Math.round(placeBox.x - boardBox.x);
  const fy = Math.round(placeBox.y - boardBox.y);
  const placeW = Math.round(placeBox.width);
  const placeH = Math.round(placeBox.height);

  // Half-slot = one tabular advance (the board's "00" is two advances wide).
  const halfW = Math.floor(placeW / 2);
  // Centre each sprite on its half-slot. For wider-than-half sprites (padded
  // capture) the offset is negative — the padding intentionally hangs off the
  // side; the clip/source math in `drawPaletted` handles negative minX.
  const tensMinX = fx + Math.round((halfW - tensImg.width) / 2);
  const onesMinX = fx + halfW + Math.round((halfW - onesImg.width) / 2);

  return [
    { minX: tensMinX, minY: fy, maxX: tensMinX + tensImg.width, maxY: fy + placeH },
    { minX: onesMinX, minY: fy, maxX: onesMinX + onesImg.width, maxY: fy + placeH },
  ];
}

/**
 * Composite the frame's digits into `frame` over `bg`, using the per-place
 * bounding boxes captured against the board PNG. For each time-unit slot
 * (days/hours/minutes/seconds) two 0-based digit sprites (tens + ones) are
 * placed side-by-side within the slot and composited via `drawPaletted`.
 *
 * `places` optionally restricts which slots are drawn — overlay frames pass
 * only the slots whose value changed since the previous frame, so each overlay
 * carries just the changed digits.
 */
function drawDigitFrames(
  timeDigits: TimeDigits,
  boardBoxes: ReadonlyMap<string, BoundingBox>,
  digitImages: ReadonlyMap<string, RasterImage>,
  bg: PalettedFrame,
  frame: PalettedFrame,
  palette: RenderPalette,
  places?: ReadonlySet<string>,
): void {
  for (const place of Object.keys(timeDigits)) {
    if (places && !places.has(place)) continue;
    const rects = placeDigitRects(place, timeDigits, boardBoxes, digitImages);
    if (!rects) continue;

    const [tensRect, onesRect] = rects;
    const [tensKey, onesKey] = timeDigits[place];
    const tensImg = digitImages.get(tensKey);
    const onesImg = digitImages.get(onesKey);

    // `skipTransparent: true` — padded tens/ones sprites overlap at the seam; a
    // transparent padding pixel must NOT overwrite the neighbour's ink there.
    if (tensImg) drawPaletted(bg, frame, tensRect, tensImg, palette, true);
    if (onesImg) drawPaletted(bg, frame, onesRect, onesImg, palette, true);
  }
}

// ─── Frame allocation ───────────────────────────────────────────────────────

/**
 * Allocate a fresh paletted frame of the given dimensions, filled with the
 * transparent slot. Matches Go's `image.NewPaletted(bounds, palette)`.
 */
function newFrame(width: number, height: number, fillSlot = TRANSPARENT_SLOT): PalettedFrame {
  return {
    pix: new Uint8Array(width * height).fill(fillSlot),
    stride: width,
    width,
    height,
  };
}

/** Deep-copy a paletted frame (own pixel buffer). Used to build the static / PNG-fallback frame from the board. */
function cloneFrame(src: PalettedFrame): PalettedFrame {
  return { pix: new Uint8Array(src.pix), stride: src.stride, width: src.width, height: src.height };
}

// ─── PNG re-encoding of frame 0 (Outlook fallback) ─────────────────────────

/**
 * Build a minimal PNG byte stream from an RGBA buffer using pngjs.
 *
 * Used to ship frame 0 as `image/png` to Outlook (Improvement 2). pngjs is
 * already a renderer dependency for PNG DEcoding (board.png + digits.png);
 * reusing it for ENcoding keeps the dependency surface tight.
 *
 * Returns a Uint8Array view of the PNG bytes.
 */
function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const png = new PNG({ width, height });
  // pngjs stores RGBA tightly packed in `png.data` (a Buffer). A direct
  // Buffer.copy from our Uint8Array preserves byte layout exactly.
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return PNG.sync.write(png) as unknown as Uint8Array;
}

/**
 * Materialize a PalettedFrame into an RGBA buffer by looking up each slot
 * index in the palette. Used to re-encode frame 0 as PNG (the Outlook fallback).
 *
 * Transparent slots (slot 0) become alpha=0 pixels — PNG preserves them
 * correctly via its alpha channel.
 */
function frameToRgba(frame: PalettedFrame, palette: RenderPalette): Uint8Array {
  const out = new Uint8Array(frame.width * frame.height * 4);
  for (let i = 0; i < frame.pix.length; i++) {
    const slot = frame.pix[i];
    const rgba = palette.rgba[slot] ?? TRANSPARENT_RGBA;
    out[i * 4] = rgba[0];
    out[i * 4 + 1] = rgba[1];
    out[i * 4 + 2] = rgba[2];
    out[i * 4 + 3] = rgba[3];
  }
  return out;
}

// ─── Public entry: renderCountdownGif ───────────────────────────────────────

/**
 * The faithful renderer entry point. PURE — same inputs always produce the
 * same byte output (no Date.now(), no Math.random()).
 *
 * Inputs:
 *   - `board`        : decoded board.png (the static board artwork)
 *   - `digits`       : decoded digits.png (the 0-9 digit sprite sheet)
 *   - `boardBoxes`   : per-element bounding boxes captured against board.png
 *   - `digitsBoxes`  : per-element bounding boxes captured against digits.png
 *   - `colors`       : the three brand colors (digit / board / border)
 *   - `remainingMs`  : milliseconds remaining until the countdown's end
 *
 * Output:
 *   - `gifBytes` : full GIF89a stream. Frame 0 = the BLANK board (persistent
 *                  base, DisposalNone). Frames 1..N = full digit frames (one per
 *                  remaining second, DISPOSAL_PREVIOUS), up to FRAME_COUNT (30).
 *                  Expired → a single static frame with all-zero digits baked in.
 *   - `pngBytes` : PNG-encoded board + CURRENT digits (Outlook `<!--[if mso]>`
 *                  fallback — NOT the blank GIF frame 0, so Outlook shows the time).
 *
 * The render is split into clearly delineated phases that mirror the Go
 * source so a side-by-side review is straightforward:
 *   1. Build palette (transparent + Plan9 + brand colors merged in)
 *   2. Pre-compute time fragments for every frame
 *   3. Pre-slice the digit sprite cache (0-based glyph buffers)
 *   4. Quantize the board PNG into the board frame — BLANK digit slots, the
 *      clean base every digit frame composites over / restores to
 *   5. GIF assembly: blank frame 0 (DisposalNone) + one full digit frame per
 *      remaining second (DISPOSAL_PREVIOUS); expired → one static frame
 *   6. PNG fallback = board + current digits (for Outlook)
 */
export function renderCountdownGif(
  board: RasterImage,
  digits: RasterImage,
  boardBoxesInput: ReadonlyArray<BoundingBox>,
  digitsBoxesInput: ReadonlyArray<BoundingBox>,
  colors: CountdownColors,
  remainingMs: number,
): RenderedArtifacts {
  // Index the boxes by key for O(1) lookup.
  // The capture pre-pass persists BARE keys ("days", "0".."9") without the
  // "board-"/"digits-" prefix the renderer looks up by, so normalize them
  // (and synthesize the parent "board"/"digits" box) before use.
  const boardBoxes = normalizeBoxes(
    boardBoxesInput,
    BOARD_KEY,
    ['days', 'hours', 'minutes', 'seconds'],
    board.width,
    board.height,
  );
  const digitBoxes = normalizeBoxes(
    digitsBoxesInput,
    DIGITS_KEY,
    ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
    digits.width,
    digits.height,
  );

  // ── Phase 1: palette ────────────────────────────────────────────────────
  const palette = buildPalette(colors);

  // ── Phase 2: time fragments per frame ───────────────────────────────────
  // Iterate `frames+1` times but break early when `dur` goes negative —
  // so the actual frame count is min(frames+1, n) where n is the number
  // of seconds remaining + 1.
  const frameTimes: TimeDigits[] = [];
  const allDigitKeys = new Set<string>();
  let dur = remainingMs;
  for (let n = 0; n < FRAME_COUNT + 1; n++) {
    const fragments = getTimeFragments(dur);
    frameTimes.push(fragments);
    for (const place of Object.keys(fragments)) {
      const [tens, ones] = fragments[place];
      allDigitKeys.add(tens);
      allDigitKeys.add(ones);
    }
    dur -= 1000;
    if (dur < 0) break;
  }

  // ── Phase 3: pre-compute digit sprite cache (0-based glyph buffers) ──────
  const digitImages = buildDigitImageCache(digitBoxes, allDigitKeys, digits);

  // ── Phase 4: board frame (the BLANK animation base) ─────────────────────
  // The board PNG is the static artwork — border, slot cards, dividers, unit
  // labels, and BLANK digit slots (the capture paints its "00" placeholders
  // `color:transparent`). Quantize it INTO the palette by drawing it over
  // itself. This frame carries NO digits, so it is the clean base every digit
  // frame composites over and DISPOSAL_PREVIOUS restores to — nothing to ghost.
  const boardWidth = board.width;
  const boardHeight = board.height;
  const boardFrame = newFrame(boardWidth, boardHeight, TRANSPARENT_SLOT);
  drawPaletted(boardFrame, boardFrame, { minX: 0, minY: 0, maxX: boardWidth, maxY: boardHeight }, board, palette);

  // A transparent board (`boardBackground: 'transparent'`, captured with
  // `omitBackground: true`) quantizes its transparent regions to
  // `TRANSPARENT_SLOT`. When present, the persistent base frame (frame 0) and the
  // expired static frame must carry the GIF transparency flag so those pixels show
  // the email background through instead of rendering slot 0's RGB as opaque black.
  // OPAQUE boards have no slot-0 pixels here, so this is `false` and their frames
  // stay byte-identical (`transparentIndex: 0` is a no-op when `transparent:false`).
  const boardHasTransparency = boardFrame.pix.some((s) => s === TRANSPARENT_SLOT);

  // ── Phase 5: GIF assembly (reference model) ─────────────────────────────
  const gifPalette: ReadonlyArray<readonly [number, number, number]> = palette.rgba.map(
    (c) => [c[0], c[1], c[2]] as const,
  );
  const gif = GIFEncoder();

  // `frameTimes` always has >= 1 entry; length === 1 means the countdown is
  // EXPIRED (the frame loop broke on the first negative `dur`). Bake the
  // all-zero digits into the board and emit ONE static frame — no animation.
  if (frameTimes.length <= 1) {
    const staticFrame = cloneFrame(boardFrame);
    if (frameTimes.length > 0) {
      drawDigitFrames(frameTimes[0], boardBoxes, digitImages, boardFrame, staticFrame, palette);
    }
    gif.writeFrame(staticFrame.pix, boardWidth, boardHeight, {
      palette: gifPalette,
      repeat: 0,
      delay: BASE_FRAME_DELAY_MS,
      transparent: boardHasTransparency,
      transparentIndex: TRANSPARENT_SLOT,
      dispose: DISPOSAL_NONE,
    });
    gif.finish();
    const gifBytes = gif.bytes();
    const pngBytes = encodePng(frameToRgba(staticFrame, palette), boardWidth, boardHeight);
    return { gifBytes, pngBytes };
  }

  // Frame 0: the BLANK board (no digits). DisposalNone → it persists as the
  // base every DISPOSAL_PREVIOUS digit frame restores to. `delay: 0` so the
  // blank board is shown imperceptibly — animating clients see the first digit
  // frame at t≈0; the base only serves disposal + the frozen-frame fallback.
  // `repeat: 0` writes the NETSCAPE2.0 loop-forever extension.
  gif.writeFrame(boardFrame.pix, boardWidth, boardHeight, {
    palette: gifPalette,
    repeat: 0,
    delay: BASE_FRAME_DELAY_MS,
    transparent: boardHasTransparency,
    transparentIndex: TRANSPARENT_SLOT,
    dispose: DISPOSAL_NONE,
  });

  // Frames 1..N: one per remaining second. Each is a fresh transparent frame
  // with ALL FOUR slots' digits composited over the blank board (the sprite's
  // transparent background blends to the board color = an invisible box; the
  // glyph paints in the digit color). `dispose: 3` (RESTORE PREVIOUS) wipes the
  // digits back to the blank board before the next frame, so no second's digits
  // ghost into the next. `delay: 1000` = 1 fps in gifenc's ms units.
  for (let n = 0; n < frameTimes.length; n++) {
    const digitFrame = newFrame(boardWidth, boardHeight, TRANSPARENT_SLOT);
    drawDigitFrames(frameTimes[n], boardBoxes, digitImages, boardFrame, digitFrame, palette);
    gif.writeFrame(digitFrame.pix, boardWidth, boardHeight, {
      delay: OVERLAY_FRAME_DELAY_MS,
      transparent: true,
      transparentIndex: TRANSPARENT_SLOT,
      dispose: DISPOSAL_PREVIOUS,
    });
  }

  gif.finish();
  const gifBytes = gif.bytes();

  // ── Phase 6: PNG fallback (Outlook `<!--[if mso]>`) ─────────────────────
  // The GIF's frame 0 is intentionally BLANK, but Outlook renders only the
  // static PNG — so the PNG composites the CURRENT second's digits onto the
  // board (NOT the blank frame 0) so Outlook shows the right remaining time.
  const pngFrame = cloneFrame(boardFrame);
  drawDigitFrames(frameTimes[0], boardBoxes, digitImages, boardFrame, pngFrame, palette);
  const pngBytes = encodePng(frameToRgba(pngFrame, palette), boardWidth, boardHeight);

  return { gifBytes, pngBytes };
}
