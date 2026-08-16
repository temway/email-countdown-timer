// Vitest tests for the countdown GIF renderer.
//
// Tests the PURE renderer in isolation — no DB, no storage, no HTTP. The bulk
// of these tests guard the byte-level contract:
//
//   - GIF frame 0 is the BLANK board (no digits) — the persistent DisposalNone
//     base every DISPOSAL_PREVIOUS digit frame restores to. The `pngBytes`
//     Outlook fallback is a SEPARATE composite (board + current digits) so
//     Outlook (which renders only the static PNG) still shows the time.
//   - gifenc GCE has disposal=3 (DISPOSAL_PREVIOUS) on every digit frame
//     (Contract 9 caveat #1). gifenc's README only documents dispose=-1 / 2,
//     but the source masks `dispose & 7` so value 3 works. If a future gifenc
//     upgrade drops this, the test must fail.
//   - gifenc delay is in MILLISECONDS, not centiseconds (Contract 9 caveat #2).
//     Target output is 100cs per frame; we pass delay=1000 to gifenc, encoded
//     as 100cs in the GCE bytes.
//   - Palette-mode encoding (Contract 9 hard requirement): the GIF's global
//     color table is the CALLER-SUPPLIED 256-entry palette (transparent slot +
//     Plan9[0..254] with the 3 brand colors overlaid). NOT auto-quantized by
//     gifenc.
//   - Determinism (Contract 10): same inputs produce same bytes across runs.
//     A committed golden fixture guards cross-machine / cross-time drift.
//
// ## AAA pattern
//
// Every test follows Arrange -> Act -> Assert. Each it() tests one behavior.
//
// ## Fixtures
//
// Two synthetic fixtures are built in-process (no network, no PNG files on
// disk for inputs): a small one (60x20 board, 100x20 digits) for correctness
// tests, and a production-shaped one (600x120 board, 300x120 digits) for the
// performance + file-size tests. The golden GIF/PNG pair is committed under
// __fixtures__/ and auto-regenerated on the first run if missing.

import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decompressFrames, parseGIF } from 'gifuct-js';
import { PNG } from 'pngjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { type BoundingBox, type CountdownColors, type RasterImage, renderCountdownGif } from './compositor.js';

/**
 * `parseGIF` is typed (and documented) to take an `ArrayBuffer`. Passing a
 * `Uint8Array` happens to work at runtime via `new Uint8Array(...)`'s copy
 * constructor, but TypeScript 5.7+ rejects it since `Uint8Array` became generic
 * over its backing buffer. `.slice()` yields an exactly-sized buffer at offset
 * 0, so this is a faithful conversion rather than a cast that could expose
 * neighbouring bytes of a pooled Node Buffer.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

// --- Fixture paths ---------------------------------------------------------

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(MODULE_DIR, '__fixtures__');
const GOLDEN_GIF_PATH = path.join(FIXTURES_DIR, 'golden.gif');
const GOLDEN_PNG_PATH = path.join(FIXTURES_DIR, 'golden.png');

// --- Synthetic fixture builders --------------------------------------------

/**
 * NOTE: a per-digit color palette was removed when the synthetic digits
 * fixture was migrated to use the single brand digit color (`COLORS.digit`).
 * Production digit sprites all share the brand color, so the renderer's
 * fixed-size palette (Plan9 + brand merge) preserves them through
 * quantization. A multi-color fixture was unrealistic and produced flaky
 * "digits appear in frame 0" assertions under GIF's 256-color limit.
 */

// The board is deliberately larger than the digits in BOTH axes so that, once
// the digits render correctly, board pixels remain visible around them (a slot
// is 30px wide but two 8px digits only span ~16px, and the digits are 24px tall
// on a 40px board). An earlier fixture used digits nearly as large as the slots,
// so correctly-rendered digits tiled the whole board and collapsed frame 0 to a
// single color — masking real rendering behavior.
const BOARD_WIDTH = 120;
const BOARD_HEIGHT = 40;
const DIGIT_W = 8;
const DIGIT_H = 24; // shorter than the board -> board pixels stay visible top/bottom
const DIGITS_IMAGE_WIDTH = DIGIT_W * 10; // 10 digit sprites side-by-side

const COLORS: CountdownColors = {
  digit: '#ffffff',
  board: '#1a2b3c',
  border: '#ff5500',
};

/**
 * Build the synthetic board image (60x20 RGBA).
 *
 * The board has a vertical gradient (top brighter than bottom) so its pixels
 * have non-trivial variance — a fully solid board would let the "frame 0 is
 * not blank" test pass even if no digits were drawn.
 */
function makeBoardRgba(): Uint8Array {
  const [br, bg, bb] = [0x1a, 0x2b, 0x3c];
  const rgba = new Uint8Array(BOARD_WIDTH * BOARD_HEIGHT * 4);
  for (let y = 0; y < BOARD_HEIGHT; y++) {
    const shade = Math.floor((y / BOARD_HEIGHT) * 40);
    for (let x = 0; x < BOARD_WIDTH; x++) {
      const i = (y * BOARD_WIDTH + x) * 4;
      rgba[i] = Math.max(0, br - shade);
      rgba[i + 1] = Math.max(0, bg - shade);
      rgba[i + 2] = Math.max(0, bb - shade);
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/**
 * Build the synthetic digits image (100x20 RGBA). 10 digit sprites laid out
 * horizontally, each 10x20, all colored with `COLORS.digit` (the brand digit
 * color) — matches production reality where every digit sprite shares the
 * single brand color and the renderer's palette (Plan9 + brand merge) is
 * guaranteed to contain that color, so digit pixels survive quantization.
 *
 * An earlier per-digit palette fixture (`DIGIT_COLORS`) was unrealistic — it
 * expected the renderer to preserve 10 distinct colors when only 1 brand
 * color is baked into the palette. That made the "digits appear in frame 0"
 * assertions flaky under GIF's 256-color quantization.
 */
function makeDigitsRgba(): Uint8Array {
  const [r, g, b] = parseHexTriplet(COLORS.digit);
  const rgba = new Uint8Array(DIGITS_IMAGE_WIDTH * DIGIT_H * 4);
  for (let digit = 0; digit < 10; digit++) {
    const cellX = digit * DIGIT_W;
    for (let y = 0; y < DIGIT_H; y++) {
      for (let x = 0; x < DIGIT_W; x++) {
        const dstX = cellX + x;
        const i = (y * DIGITS_IMAGE_WIDTH + dstX) * 4;
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = 255;
      }
    }
  }
  return rgba;
}

/** Parse `#RRGGBB` to an `[r, g, b]` triplet. Used by `makeDigitsRgba`. */
function parseHexTriplet(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, '');
  return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)];
}

/** 4 board sub-element boxes (days/hours/minutes/seconds). */
function makeBoardBoxes(): BoundingBox[] {
  const slotW = Math.floor(BOARD_WIDTH / 4);
  return [
    { key: 'board', x: 0, y: 0, width: BOARD_WIDTH, height: BOARD_HEIGHT },
    { key: 'board-days', x: 0, y: 0, width: slotW, height: BOARD_HEIGHT },
    { key: 'board-hours', x: slotW, y: 0, width: slotW, height: BOARD_HEIGHT },
    { key: 'board-minutes', x: slotW * 2, y: 0, width: slotW, height: BOARD_HEIGHT },
    { key: 'board-seconds', x: slotW * 3, y: 0, width: slotW, height: BOARD_HEIGHT },
  ];
}

/** 10 digit-cell boxes inside the digits.png sprite sheet. */
function makeDigitsBoxes(): BoundingBox[] {
  const boxes: BoundingBox[] = [{ key: 'digits', x: 0, y: 0, width: DIGITS_IMAGE_WIDTH, height: DIGIT_H }];
  for (let i = 0; i < 10; i++) {
    boxes.push({
      key: `digits-${i}`,
      x: i * DIGIT_W,
      y: 0,
      width: DIGIT_W,
      height: DIGIT_H,
    });
  }
  return boxes;
}

/** Small fixture: 60x20 board, 100x20 digits. Used for correctness tests. */
function makeSmallFixture(remainingMs = 30_000): {
  board: RasterImage;
  digits: RasterImage;
  boardBoxes: BoundingBox[];
  digitsBoxes: BoundingBox[];
  colors: CountdownColors;
  remainingMs: number;
} {
  return {
    board: { rgba: makeBoardRgba(), width: BOARD_WIDTH, height: BOARD_HEIGHT },
    digits: { rgba: makeDigitsRgba(), width: DIGITS_IMAGE_WIDTH, height: DIGIT_H },
    boardBoxes: makeBoardBoxes(),
    digitsBoxes: makeDigitsBoxes(),
    colors: COLORS,
    remainingMs,
  };
}

/**
 * Large fixture for perf + file-size tests: 600x120 board, 300x120 digits,
 * 30s remaining -> 31 frames at production-realistic dimensions.
 */
function makeLargeFixture(): {
  board: RasterImage;
  digits: RasterImage;
  boardBoxes: BoundingBox[];
  digitsBoxes: BoundingBox[];
  colors: CountdownColors;
  remainingMs: number;
} {
  const W = 600;
  const H = 120;
  const DIG_W_BIG = 30;
  const DIG_SHEET_W = DIG_W_BIG * 10;

  const boardRgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const shade = Math.floor((y / H) * 40);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      boardRgba[i] = Math.max(0, 0x1a - shade);
      boardRgba[i + 1] = Math.max(0, 0x2b - shade);
      boardRgba[i + 2] = Math.max(0, 0x3c - shade);
      boardRgba[i + 3] = 255;
    }
  }

  const digitsRgba = new Uint8Array(DIG_SHEET_W * H * 4);
  const [dr, dg, db] = parseHexTriplet(COLORS.digit);
  for (let digit = 0; digit < 10; digit++) {
    const cellX = digit * DIG_W_BIG;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < DIG_W_BIG; x++) {
        const dstX = cellX + x;
        const i = (y * DIG_SHEET_W + dstX) * 4;
        digitsRgba[i] = dr;
        digitsRgba[i + 1] = dg;
        digitsRgba[i + 2] = db;
        digitsRgba[i + 3] = 255;
      }
    }
  }

  const slotW = 100;
  const slotY = 10;
  const slotH = 100;
  const slotXs = [50, 175, 300, 425];

  return {
    board: { rgba: boardRgba, width: W, height: H },
    digits: { rgba: digitsRgba, width: DIG_SHEET_W, height: H },
    boardBoxes: [
      { key: 'board', x: 0, y: 0, width: W, height: H },
      { key: 'board-days', x: slotXs[0], y: slotY, width: slotW, height: slotH },
      { key: 'board-hours', x: slotXs[1], y: slotY, width: slotW, height: slotH },
      { key: 'board-minutes', x: slotXs[2], y: slotY, width: slotW, height: slotH },
      { key: 'board-seconds', x: slotXs[3], y: slotY, width: slotW, height: slotH },
    ],
    digitsBoxes: [
      { key: 'digits', x: 0, y: 0, width: DIG_SHEET_W, height: H },
      ...Array.from({ length: 10 }, (_, i) => ({
        key: `digits-${i}`,
        x: i * DIG_W_BIG,
        y: 0,
        width: DIG_W_BIG,
        height: H,
      })),
    ],
    colors: COLORS,
    remainingMs: 30_000,
  };
}

// --- GIF byte-parsing helpers ----------------------------------------------

const GIF89A_HEADER = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // "GIF89a"

/** Assert the leading 6 bytes match the GIF89a signature. */
function assertGif89a(bytes: Uint8Array): void {
  for (let i = 0; i < GIF89A_HEADER.length; i++) {
    expect(bytes[i], `byte ${i} of GIF header`).toBe(GIF89A_HEADER[i]);
  }
}

/**
 * Parsed Graphic Control Extension block.
 *
 * Layout (8 bytes total including terminator):
 *   0x21              Extension Introducer
 *   0xf9              Graphic Control Label
 *   0x04              Block size (4 bytes follow)
 *   <packed>          Bits: 0=transparent, 1=user-input, 2-4=disposal, 5-7 reserved
 *   <delay_lo>        Delay (centiseconds) — low byte
 *   <delay_hi>        Delay (centiseconds) — high byte
 *   <transparent_idx> Palette slot used as the transparent color
 *   0x00              Block terminator
 */
interface GceBlock {
  /** Byte offset where the 0x21 introducer sits in the source stream. */
  offset: number;
  packed: number;
  /** Delay in centiseconds (gifenc converts from ms via Math.round(ms / 10)). */
  delayCs: number;
  transparentIndex: number;
  /** Disposal method (bits 2-4 of the packed byte, 0-7). */
  disposal: number;
  /** Whether the transparent-color flag (bit 0) is set. */
  transparent: boolean;
}

/**
 * Scan the byte stream for all GCE blocks. Searches for the unique 3-byte
 * signature 0x21 0xf9 0x04. A well-formed GIF never emits these bytes as
 * image data (they would be inside an LZW stream), so the scan is robust for
 * the renderer's deterministic output and avoids a full GIF parser dep.
 */
function parseGceBlocks(bytes: Uint8Array): GceBlock[] {
  const out: GceBlock[] = [];
  for (let i = 0; i + 7 <= bytes.length; i++) {
    if (bytes[i] !== 0x21 || bytes[i + 1] !== 0xf9 || bytes[i + 2] !== 0x04) continue;
    const packed = bytes[i + 3];
    const delayCs = bytes[i + 4] | (bytes[i + 5] << 8);
    const transparentIndex = bytes[i + 6];
    out.push({
      offset: i,
      packed,
      delayCs,
      transparentIndex,
      disposal: (packed >> 2) & 0b111,
      transparent: (packed & 0b1) === 1,
    });
    // Skip past this block (7 bytes of GCE payload).
    i += 7;
  }
  return out;
}

/**
 * Parse the GIF's Global Color Table.
 *
 * Per GIF89a spec, the GCT immediately follows the 7-byte Logical Screen
 * Descriptor (which itself follows the 6-byte header). The LSD's packed byte
 * (byte 10 of the file, 0-indexed) low 3 bits give N where GCT length is
 * 2^(N+1) entries, each 3 bytes (RGB).
 *
 * Returns the palette as a list of [r, g, b] triplets.
 */
function parseGlobalColorTable(bytes: Uint8Array): Array<[number, number, number]> {
  // Header (6 bytes) + LSD packed byte at offset 10.
  const lsdPacked = bytes[10];
  const gctFlag = (lsdPacked & 0b1000_0000) !== 0;
  if (!gctFlag) return [];
  const sizeBits = lsdPacked & 0b111;
  const entryCount = 1 << (sizeBits + 1);
  const gctStart = 6 + 7; // header(6) + LSD(7)
  const palette: Array<[number, number, number]> = [];
  for (let i = 0; i < entryCount; i++) {
    const o = gctStart + i * 3;
    palette.push([bytes[o], bytes[o + 1], bytes[o + 2]]);
  }
  return palette;
}

// --- Pixel-math helpers ----------------------------------------------------

/** Compute the per-channel variance of an RGBA buffer (sum across R, G, B). */
function pixelVariance(rgba: Uint8Array): number {
  const pixelCount = rgba.length / 4;
  if (pixelCount === 0) return 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    sumR += rgba[i];
    sumG += rgba[i + 1];
    sumB += rgba[i + 2];
  }
  const meanR = sumR / pixelCount;
  const meanG = sumG / pixelCount;
  const meanB = sumB / pixelCount;
  let varSum = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    varSum += (rgba[i] - meanR) ** 2;
    varSum += (rgba[i + 1] - meanG) ** 2;
    varSum += (rgba[i + 2] - meanB) ** 2;
  }
  return varSum / (pixelCount * 3);
}

/**
 * Count how many pixels in `rgba` match the given RGB triplet (within +/- 8
 * per channel — the palette nearest-color search can introduce small drift).
 */
function countPixelsNear(rgba: Uint8Array, target: readonly [number, number, number], tolerance = 8): number {
  let count = 0;
  const [tr, tg, tb] = target;
  for (let i = 0; i < rgba.length; i += 4) {
    if (
      Math.abs(rgba[i] - tr) <= tolerance &&
      Math.abs(rgba[i + 1] - tg) <= tolerance &&
      Math.abs(rgba[i + 2] - tb) <= tolerance
    ) {
      count++;
    }
  }
  return count;
}

/**
 * Find a palette entry whose RGB triplet matches `target` within +/- 1 per
 * channel. Used by the palette-mode test to verify a caller-supplied brand
 * color survives into the encoded GIF's global color table.
 */
function paletteContains(
  palette: ReadonlyArray<readonly [number, number, number]>,
  target: readonly [number, number, number],
  tolerance = 1,
): boolean {
  return palette.some(
    ([r, g, b]) =>
      Math.abs(r - target[0]) <= tolerance &&
      Math.abs(g - target[1]) <= tolerance &&
      Math.abs(b - target[2]) <= tolerance,
  );
}

// --- Golden fixture management ---------------------------------------------

/**
 * Ensure the __fixtures__ dir + golden files exist. On FIRST RUN (no golden
 * files committed yet), writes them so the comparison test below trivially
 * passes. On subsequent runs, the comparison test reads them and verifies
 * byte-level determinism.
 *
 * To intentionally regenerate (e.g. after a renderer algorithm change),
 * delete the __fixtures__ dir and re-run.
 */
function ensureGoldenDir(): void {
  if (!existsSync(FIXTURES_DIR)) mkdirSync(FIXTURES_DIR, { recursive: true });
}

beforeAll(() => {
  ensureGoldenDir();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('renderCountdownGif — PNG fallback (Outlook static frame = board + current digits)', () => {
  it('PNG fallback decodes and is not blank (high pixel variance)', () => {
    // Arrange — a 30s countdown. remainingMs=30000 → "00d 00h 00m 30s" →
    //   digits [0,0, 0,0, 0,0, 3,0]. The Outlook PNG fallback (pngBytes) must
    //   have those digits composited onto the board (the GIF frame 0 is blank,
    //   but the PNG is a separate board+current-digits composite).
    const fixture = makeSmallFixture(30_000);

    // Act
    const { pngBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );

    // Assert — decode PNG and check pixel variance > a blank-board baseline.
    const decoded = PNG.sync.read(Buffer.from(pngBytes));
    expect(decoded.width).toBe(BOARD_WIDTH);
    expect(decoded.height).toBe(BOARD_HEIGHT);

    // A blank board (just the gradient background) has variance ~ (40^2 / 12) * 3 ≈ 400.
    // Adding digit sprites with very different colors pushes variance well above that.
    const variance = pixelVariance(decoded.data as unknown as Uint8Array);
    expect(variance, 'frame 0 should have visually distinct pixels from the digits').toBeGreaterThan(1000);
  });

  it('PNG fallback contains digit-sprite colors composited onto the board', () => {
    // Arrange — remainingMs=30000 → seconds=30 → seconds tens digit is "3"
    //   and seconds ones digit is "0". Both should appear in the rendered
    //   PNG fallback as pixels matching the brand digit color (COLORS.digit).
    //   The synthetic fixture colors every digit cell with COLORS.digit so
    //   the palette (Plan9 + brand merge) preserves them through quantization.
    const fixture = makeSmallFixture(30_000);

    // Act
    const { pngBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );

    // Assert — digit-colored pixels must appear in frame 0. The board
    // background is dark blue ([0x1a,0x2b,0x3c]) so any near-white pixels
    // can only come from the digit sprites.
    const decoded = PNG.sync.read(Buffer.from(pngBytes));
    const rgba = decoded.data as unknown as Uint8Array;
    const [digitR, digitG, digitB] = parseHexTriplet(COLORS.digit);
    const digitPixels = countPixelsNear(rgba, [digitR, digitG, digitB], 16);
    expect(digitPixels, 'digits must appear in frame 0 (brand color)').toBeGreaterThan(0);
  });

  it('PNG fallback of a 10s countdown is still non-blank', () => {
    // Arrange — a 10s timer (under 1 minute). All leading places are zero.
    //   Validates the algorithm doesn't short-circuit on small durations.
    const fixture = makeSmallFixture(10_000);

    // Act
    const { pngBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );

    // Assert — seconds=10 → tens digit "1" is drawn. Digit pixels (matching
    // COLORS.digit) must appear in the PNG fallback.
    const decoded = PNG.sync.read(Buffer.from(pngBytes));
    const rgba = decoded.data as unknown as Uint8Array;
    const [digitR, digitG, digitB] = parseHexTriplet(COLORS.digit);
    const digitPixels = countPixelsNear(rgba, [digitR, digitG, digitB], 16);
    expect(digitPixels, 'digits must appear in a 10s countdown PNG fallback').toBeGreaterThan(0);
  });
});

describe('renderCountdownGif — Contract 9 (GIF encoding contract)', () => {
  it('produces a valid GIF89a stream', () => {
    // Arrange
    const fixture = makeSmallFixture(30_000);

    // Act
    const { gifBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );

    // Assert — header must be GIF89a (NOT 87a; transparency requires 89a).
    assertGif89a(gifBytes);
  });

  it('every digit frame GCE has disposal=3 (RESTORE PREVIOUS) over the blank base', () => {
    // Arrange — 30s countdown yields 1 blank base frame + 31 digit frames
    //   (frameTimes has 31 entries: t=30s..0s inclusive).
    const fixture = makeSmallFixture(30_000);

    // Act
    const { gifBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );
    const gceBlocks = parseGceBlocks(gifBytes);

    // Assert
    //   1 GCE for the blank base (frame 0) + 31 GCEs for the digit frames.
    expect(gceBlocks.length).toBe(32);
    const digitGces = gceBlocks.slice(1);
    expect(digitGces.length).toBe(31);
    // Each digit frame draws ALL slots over the blank board then must be
    // RESTORED to that blank base before the next frame — disposal=3
    // (DISPOSAL_PREVIOUS). Because the base has no baked digits, there is
    // nothing to ghost from (the earlier baked-digit-frame-0 model ghosted).
    for (const gce of digitGces) {
      expect(gce.disposal, `GCE at offset ${gce.offset} must have disposal=3`).toBe(3);
    }
  });

  it('every digit frame GCE has transparent flag set + transparentIndex=0', () => {
    // Arrange
    const fixture = makeSmallFixture(30_000);

    // Act
    const { gifBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );
    const digitGces = parseGceBlocks(gifBytes).slice(1);

    // Assert — every digit frame is transparent at palette slot 0 (only the
    // digit rects are opaque; the rest lets the blank board show through).
    expect(digitGces.length).toBe(31);
    for (const gce of digitGces) {
      expect(gce.transparent, `GCE at offset ${gce.offset} must set transparent flag`).toBe(true);
      expect(gce.transparentIndex, `GCE at offset ${gce.offset} transparentIndex must be 0`).toBe(0);
    }
  });

  it('frame 0 (blank base) GCE has disposal=1 (DisposalNone), NOT disposal=3', () => {
    // Arrange
    const fixture = makeSmallFixture(30_000);

    // Act
    const { gifBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );
    const frame0Gce = parseGceBlocks(gifBytes)[0];

    // Assert — frame 0 (the blank board) must NOT dispose — it persists as the
    //   base every DISPOSAL_PREVIOUS digit frame restores to. disposal=1.
    expect(frame0Gce, 'frame 0 must have a GCE').toBeDefined();
    expect(frame0Gce.disposal).toBe(1);
  });

  it('digit frames delay is 100cs (1000ms in gifenc) — caveat #2', () => {
    // Arrange
    const fixture = makeSmallFixture(30_000);

    // Act
    const { gifBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );
    const digitGces = parseGceBlocks(gifBytes).slice(1);

    // Assert — gifenc takes ms (we pass 1000), converts via Math.round(ms/10)=100.
    //   If gifenc took centiseconds directly, we'd see delay=1000. That would
    //   actually break GIF viewers — they interpret the GCE delay as
    //   centiseconds, so a literal 1000 would mean 10 seconds per frame.
    for (const gce of digitGces) {
      expect(gce.delayCs, `digit-frame GCE delay must be 100cs (1 second)`).toBe(100);
    }
  });

  it('palette-mode: global color table has exactly 256 entries', () => {
    // Arrange
    const fixture = makeSmallFixture(30_000);

    // Act
    const { gifBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );
    const palette = parseGlobalColorTable(gifBytes);

    // Assert — caller supplies a 256-entry palette (1 transparent + 255 Plan9).
    //   If gifenc auto-quantized, the palette length would be a different power of 2.
    expect(palette.length).toBe(256);
  });

  it('palette-mode: all 3 brand colors appear in the global color table', () => {
    // Arrange — brand colors as RGB triplets.
    const fixture = makeSmallFixture(30_000);
    const expectedColors: ReadonlyArray<readonly [number, number, number]> = [
      [0xff, 0xff, 0xff], // digit white
      [0x1a, 0x2b, 0x3c], // board dark blue-gray
      [0xff, 0x55, 0x00], // border orange
    ];

    // Act
    const { gifBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );
    const palette = parseGlobalColorTable(gifBytes);

    // Assert — each brand color survives into the palette (the renderer's
    //   `buildPalette` replaces the nearest Plan9 entry with the brand color,
    //   so an exact match must exist).
    for (const c of expectedColors) {
      expect(paletteContains(palette, c), `brand color rgb(${c.join(',')}) must be in GCT`).toBe(true);
    }
  });
});

describe('renderCountdownGif — transparent board background (boardBackground:transparent)', () => {
  // A board captured with `omitBackground: true` keeps
  // alpha=0 wherever `boardBackground` is 'transparent'. Those pixels quantize
  // to TRANSPARENT_SLOT (slot 0), so the persistent base frame (frame 0) and the
  // single expired frame must carry the GIF transparency flag — otherwise slot
  // 0's RGB ([0,0,0]) renders as opaque BLACK instead of showing the email
  // background through. Opaque boards have no slot-0 pixels, so the flag stays
  // OFF and their bytes are unchanged (`transparentIndex:0` is a no-op then).

  /** A fully-transparent board raster (every pixel [0,0,0,0], alpha=0). */
  function makeTransparentBoardRgba(): Uint8Array {
    return new Uint8Array(BOARD_WIDTH * BOARD_HEIGHT * 4); // zero-filled = transparent
  }

  it('opaque board: frame 0 GCE transparency flag stays OFF (byte-identity gate)', () => {
    // Arrange — the default synthetic board is fully opaque (alpha=255).
    const fixture = makeSmallFixture(30_000);

    // Act
    const { gifBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );
    const frame0Gce = parseGceBlocks(gifBytes)[0];

    // Assert — no transparent board pixels -> `boardHasTransparency` is false ->
    //   frame 0 keeps `transparent:false` (byte-identical to the pre-change output).
    expect(frame0Gce.transparent).toBe(false);
  });

  it('transparent board: frame 0 (persistent base) sets transparent flag + transparentIndex=0, keeps disposal=1', () => {
    // Arrange — swap in an all-transparent board raster.
    const fixture = makeSmallFixture(30_000);
    const board: RasterImage = {
      rgba: makeTransparentBoardRgba(),
      width: BOARD_WIDTH,
      height: BOARD_HEIGHT,
    };

    // Act
    const { gifBytes } = renderCountdownGif(
      board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );
    const frame0Gce = parseGceBlocks(gifBytes)[0];

    // Assert — the base frame is now GIF-transparent at slot 0, but still the
    //   persistent base (DisposalNone), NOT DISPOSAL_PREVIOUS.
    expect(frame0Gce.transparent, 'frame 0 must set the transparency flag').toBe(true);
    expect(frame0Gce.transparentIndex, 'frame 0 transparentIndex must be slot 0').toBe(0);
    expect(frame0Gce.disposal, 'frame 0 must stay disposal=1 (persistent base)').toBe(1);
  });

  it('transparent board, EXPIRED countdown: the single static frame sets the transparent flag', () => {
    // Arrange — 0ms remaining collapses to ONE static frame (no animation).
    const fixture = makeSmallFixture(0);
    const board: RasterImage = {
      rgba: makeTransparentBoardRgba(),
      width: BOARD_WIDTH,
      height: BOARD_HEIGHT,
    };

    // Act
    const { gifBytes } = renderCountdownGif(
      board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );
    const gces = parseGceBlocks(gifBytes);

    // Assert — exactly one frame, and it must be transparent so an expired
    //   transparent board still shows the email background (not a black box).
    expect(gces.length, 'expired countdown emits exactly one static frame').toBe(1);
    expect(gces[0].transparent, 'expired static frame must set the transparency flag').toBe(true);
    expect(gces[0].transparentIndex).toBe(0);
  });
});

describe('renderCountdownGif — Contract 10 (faithful deterministic port)', () => {
  it('byte-identical output across two consecutive runs in the same process', () => {
    // Arrange — identical inputs. The renderer must be PURE (no Date.now(),
    //   no Math.random()) so two calls produce identical bytes.
    const fixtureA = makeSmallFixture(30_000);
    const fixtureB = makeSmallFixture(30_000);

    // Act
    const resultA = renderCountdownGif(
      fixtureA.board,
      fixtureA.digits,
      fixtureA.boardBoxes,
      fixtureA.digitsBoxes,
      fixtureA.colors,
      fixtureA.remainingMs,
    );
    const resultB = renderCountdownGif(
      fixtureB.board,
      fixtureB.digits,
      fixtureB.boardBoxes,
      fixtureB.digitsBoxes,
      fixtureB.colors,
      fixtureB.remainingMs,
    );

    // Assert — bytes match exactly. Uint8Array equality requires Buffer.compare
    //   or byte-by-byte; we use Buffer.compare for O(n) and clear diff output.
    expect(resultA.gifBytes.length).toBe(resultB.gifBytes.length);
    expect(Buffer.compare(Buffer.from(resultA.gifBytes), Buffer.from(resultB.gifBytes))).toBe(0);
    expect(Buffer.compare(Buffer.from(resultA.pngBytes), Buffer.from(resultB.pngBytes))).toBe(0);
  });

  it('byte-identical to committed golden fixture (auto-regenerates on first run)', () => {
    // Arrange — load (or generate) the golden GIF + PNG pair under __fixtures__/.
    const fixture = makeSmallFixture(30_000);

    // Act
    const { gifBytes, pngBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );

    // Assert — if golden files don't exist yet (first run, fresh clone), write
    //   them and pass. On subsequent runs, the new render must match the
    //   committed bytes exactly — guards against accidental algorithm drift.
    if (!existsSync(GOLDEN_GIF_PATH) || !existsSync(GOLDEN_PNG_PATH)) {
      writeFileSync(GOLDEN_GIF_PATH, Buffer.from(gifBytes));
      writeFileSync(GOLDEN_PNG_PATH, Buffer.from(pngBytes));
      // Skip the comparison on the regenerating run; the next run will compare.
      console.warn(
        '[compositor.test] golden fixture missing — wrote fresh bytes to',
        FIXTURES_DIR,
        '. Commit them.',
      );
      return;
    }

    const goldenGif = readFileSync(GOLDEN_GIF_PATH);
    const goldenPng = readFileSync(GOLDEN_PNG_PATH);

    expect(
      Buffer.compare(Buffer.from(gifBytes), goldenGif),
      'fresh render must match committed golden.gif — if you intentionally changed the algorithm, delete __fixtures__/ and re-run',
    ).toBe(0);
    expect(Buffer.compare(Buffer.from(pngBytes), goldenPng), 'fresh PNG render must match committed golden.png').toBe(
      0,
    );
  });

  it('different remainingMs produces different GIF bytes (sanity)', () => {
    // Arrange — two fixtures differing ONLY in remainingMs.
    //   Negative test: confirms the renderer actually consumes remainingMs and
    //   bakes the time into the output. A bug that ignores remainingMs would
    //   produce identical bytes (failing this test before the determinism test).
    const fixture30s = makeSmallFixture(30_000);
    const fixture20s = makeSmallFixture(20_000);

    // Act
    const a = renderCountdownGif(
      fixture30s.board,
      fixture30s.digits,
      fixture30s.boardBoxes,
      fixture30s.digitsBoxes,
      fixture30s.colors,
      fixture30s.remainingMs,
    );
    const b = renderCountdownGif(
      fixture20s.board,
      fixture20s.digits,
      fixture20s.boardBoxes,
      fixture20s.digitsBoxes,
      fixture20s.colors,
      fixture20s.remainingMs,
    );

    // Assert — bytes must differ (the digit positions are different).
    expect(Buffer.compare(Buffer.from(a.gifBytes), Buffer.from(b.gifBytes))).not.toBe(0);
  });
});

describe('renderCountdownGif — label colour (4th brand colour)', () => {
  /**
   * `label` is the only optional colour, and the common case is `label ===
   * digit` (captions share the digit ink unless `?label` says otherwise). That
   * case MUST be byte-identical to the three-colour render: the palette merge
   * appends label last, where an exact-match hit rewrites digit's own slot with
   * identical values. If this test fails, every URL without `?label` changed
   * bytes for nothing.
   */
  it('label === digit is byte-identical to omitting the label colour', () => {
    // Arrange
    const fixture = makeSmallFixture(30_000);
    const withLabel: CountdownColors = { ...COLORS, label: COLORS.digit };

    // Act
    const threeColour = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );
    const fourColour = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      withLabel,
      fixture.remainingMs,
    );

    // Assert
    expect(Buffer.compare(Buffer.from(threeColour.gifBytes), Buffer.from(fourColour.gifBytes))).toBe(0);
    expect(Buffer.compare(Buffer.from(threeColour.pngBytes), Buffer.from(fourColour.pngBytes))).toBe(0);
  });

  it('a distinct label colour survives into the global color table', () => {
    // Arrange — a caption ink nowhere near the other three brand colours.
    const fixture = makeSmallFixture(30_000);
    const label = '#00ff88';
    const [lr, lg, lb] = parseHexTriplet(label);

    // Act
    const { gifBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      { ...COLORS, label },
      fixture.remainingMs,
    );
    const palette = parseGlobalColorTable(gifBytes);

    // Assert
    expect(paletteContains(palette, [lr, lg, lb])).toBe(true);
  });
});

describe('renderCountdownGif — performance', () => {
  it('cold-miss render of a 600x120 30-frame timer completes under 200ms', () => {
    // Arrange — production-shaped fixture (the spec's target size).
    //   600x120 board, 300x120 digits, 30s remaining -> 31 frames total.
    //   Target: 200ms cold-miss per 20s-bucket render.
    const fixture = makeLargeFixture();

    // Act
    const start = performance.now();
    renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );
    const elapsed = performance.now() - start;

    // Assert — the per-frame bg-aware palette compositing loop with the
    //   per-render cache must stay under 200ms for a single cold render.
    //   CI runners are typically slower than dev machines, so the threshold
    //   doubles the target — the local budget remains 200ms.
    expect(elapsed, `render took ${elapsed.toFixed(1)}ms`).toBeLessThan(400);
  });
});

describe('renderCountdownGif — file size', () => {
  it('600x120 30-frame GIF output stays under 500KB', () => {
    // Arrange
    const fixture = makeLargeFixture();

    // Act
    const { gifBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );

    // Assert — Contract target: < 500KB for a 30-frame 600x120 timer.
    //   The synthetic fixture's solid-color sprites compress well (each frame
    //   is mostly transparent + 2 small digit sprites), so this is a generous
    //   upper bound. Real captures with anti-aliased text will be larger but
    //   should still fit under 500KB.
    expect(gifBytes.length).toBeLessThan(500 * 1024);
  });
});

describe('renderCountdownGif — defensive parsing', () => {
  it('rejects an invalid hex color in the brand palette', () => {
    // Arrange — board color is malformed (5 hex chars instead of 6).
    const fixture = makeSmallFixture(30_000);
    const badColors: CountdownColors = {
      digit: fixture.colors.digit,
      board: '#12345', // invalid — parseHex requires exactly 6 hex chars
      border: fixture.colors.border,
    };

    // Act + Assert — parseHex throws synchronously inside buildPalette.
    expect(() =>
      renderCountdownGif(
        fixture.board,
        fixture.digits,
        fixture.boardBoxes,
        fixture.digitsBoxes,
        badColors,
        fixture.remainingMs,
      ),
    ).toThrow(/Invalid hex color/);
  });
});

describe('renderCountdownGif — box key normalization (Contract: bare-key capture format)', () => {
  /**
   * The capture pre-pass persists BARE box keys
   * ("days"/"hours"/"minutes"/"seconds" and "0".."9") — `extractKey` strips
   * the `countdown-board-` / `countdown-digits-` prefix before writing. The
   * renderer must accept that format (and synthesize the parent "board" /
   * "digits" box) rather than requiring the prefixed keys. A regression here
   * would make every real countdown render a STATIC board with no ticking
   * digits (overlay frames all blank).
   */
  it('renders ticking digits when boxes use bare keys', () => {
    // Arrange — bare-key boxes, exactly as the capture pre-pass persists them.
    const fixture = makeSmallFixture(30_000);
    const slotW = Math.floor(BOARD_WIDTH / 4);
    const bareBoardBoxes: BoundingBox[] = [
      { key: 'days', x: 0, y: 0, width: slotW, height: BOARD_HEIGHT },
      { key: 'hours', x: slotW, y: 0, width: slotW, height: BOARD_HEIGHT },
      { key: 'minutes', x: slotW * 2, y: 0, width: slotW, height: BOARD_HEIGHT },
      { key: 'seconds', x: slotW * 3, y: 0, width: slotW, height: BOARD_HEIGHT },
    ];
    const bareDigitsBoxes: BoundingBox[] = [];
    for (let i = 0; i < 10; i++) {
      bareDigitsBoxes.push({ key: `${i}`, x: i * DIGIT_W, y: 0, width: DIGIT_W, height: DIGIT_H });
    }

    // Act — render with bare keys.
    const { gifBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      bareBoardBoxes,
      bareDigitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );

    // Assert — decode and confirm overlay frames carry digit pixels (not blank).
    // If the renderer required prefixed keys, every overlay frame would be
    // fully transparent (the digits never get drawn) and this would fail.
    const frames = decompressFrames(parseGIF(toArrayBuffer(gifBytes)), true);
    expect(frames.length).toBeGreaterThan(1);

    let overlayNonZero = 0;
    for (let i = 1; i < frames.length; i++) {
      const px = frames[i].patch;
      for (let j = 0; j < px.length; j += 4) {
        if (px[j] !== 0 || px[j + 1] !== 0 || px[j + 2] !== 0 || px[j + 3] !== 0) {
          overlayNonZero++;
          break;
        }
      }
    }
    expect(overlayNonZero, 'at least some overlay frames must contain digit pixels').toBeGreaterThan(0);
  });

  it('still accepts prefixed keys (backwards-compatible)', () => {
    // Arrange — the previously-documented prefixed format.
    const fixture = makeSmallFixture(30_000);
    const { gifBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      fixture.remainingMs,
    );
    const frames = decompressFrames(parseGIF(toArrayBuffer(gifBytes)), true);
    let overlayNonZero = 0;
    for (let i = 1; i < frames.length; i++) {
      const px = frames[i].patch;
      for (let j = 0; j < px.length; j += 4) {
        if (px[j] !== 0 || px[j + 1] !== 0 || px[j + 2] !== 0 || px[j + 3] !== 0) {
          overlayNonZero++;
          break;
        }
      }
    }
    expect(overlayNonZero).toBeGreaterThan(0);
  });
});

// --- Positional correctness + no-ghosting fixture --------------------------
//
// This fixture is the one that would have caught the production bugs: the digit
// sprites live at SHEET positions that differ from their on-board SLOT
// positions, the board has 10px left padding (so slot x != 0), and the digit
// widths VARY per digit. Each digit N is a solid white rect of width 20 + 3N,
// so the rendered digit's VALUE is decodable from the inked width in a slot
// half. Any of the three bugs — the sheet-vs-slot coordinate mismatch, the
// child-union parent-origin offset, or overlay ghosting — makes at least one
// slot decode to the wrong value (or no ink at all).

const POS = {
  boardW: 440,
  boardH: 60,
  slotW: 100,
  slotY: 5,
  slotH: 50,
  slotXs: [10, 120, 230, 340], // 10px left pad + 10px gaps -> exercises parent-origin
  digitH: 50,
};

/** Variable digit widths, kept <= slotW/2 so each digit stays within its half. */
function posDigitWidth(n: number): number {
  return 20 + 3 * n; // 20..47
}

function makePositionalFixture(remainingMs: number): {
  board: RasterImage;
  digits: RasterImage;
  boardBoxes: BoundingBox[];
  digitsBoxes: BoundingBox[];
  colors: CountdownColors;
  remainingMs: number;
} {
  const [br, bgc, bb] = parseHexTriplet(COLORS.board);
  const board = new Uint8Array(POS.boardW * POS.boardH * 4);
  for (let i = 0; i < POS.boardW * POS.boardH; i++) {
    board[i * 4] = br;
    board[i * 4 + 1] = bgc;
    board[i * 4 + 2] = bb;
    board[i * 4 + 3] = 255;
  }

  // Digit sheet: variable-width solid white sprites laid out left-to-right at
  // positions that deliberately do NOT line up with the board slots.
  const widths = Array.from({ length: 10 }, (_, n) => posDigitWidth(n));
  const xs: number[] = [];
  let acc = 0;
  for (const w of widths) {
    xs.push(acc);
    acc += w;
  }
  const sheetW = acc;
  const [dr, dg, db] = parseHexTriplet(COLORS.digit);
  const digits = new Uint8Array(sheetW * POS.digitH * 4);
  for (let n = 0; n < 10; n++) {
    for (let y = 0; y < POS.digitH; y++) {
      for (let x = 0; x < widths[n]; x++) {
        const i = (y * sheetW + xs[n] + x) * 4;
        digits[i] = dr;
        digits[i + 1] = dg;
        digits[i + 2] = db;
        digits[i + 3] = 255;
      }
    }
  }

  const units = ['days', 'hours', 'minutes', 'seconds'] as const;
  const boardBoxes: BoundingBox[] = units.map((k, idx) => ({
    key: k,
    x: POS.slotXs[idx],
    y: POS.slotY,
    width: POS.slotW,
    height: POS.slotH,
  }));
  const digitsBoxes: BoundingBox[] = Array.from({ length: 10 }, (_, n) => ({
    key: `${n}`,
    x: xs[n],
    y: 0,
    width: widths[n],
    height: POS.digitH,
  }));

  return {
    board: { rgba: board, width: POS.boardW, height: POS.boardH },
    digits: { rgba: digits, width: sheetW, height: POS.digitH },
    boardBoxes,
    digitsBoxes,
    colors: COLORS,
    remainingMs,
  };
}

/** Mirror of the renderer's getTimeFragments (floor decomposition). */
function expectedFragments(durMs: number): {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
} {
  if (durMs <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
  const t = durMs / 1000;
  const days = Math.floor(t / 86400);
  const hours = Math.floor(t / 3600 - days * 24);
  const minutes = Math.floor(t / 60 - days * 1440 - hours * 60);
  const seconds = Math.floor(t - days * 86400 - hours * 3600 - minutes * 60);
  return { days, hours, minutes, seconds };
}

/**
 * Composite the GIF's frames applying disposal. Frame 0 is the opaque BLANK
 * board base; every subsequent digit frame is DISPOSAL_PREVIOUS, so it is
 * composited over a FRESH copy of that base (restored before each frame) —
 * NOT accumulated. Returns the full-canvas RGBA for each frame, so
 * `canvases[0]` is the blank board and `canvases[i>=1]` is board + the i-th
 * second's digits.
 */
function compositeFrames(gifBytes: Uint8Array, width: number, height: number): Uint8Array[] {
  const frames = decompressFrames(parseGIF(toArrayBuffer(gifBytes)), true);
  const applyPatch = (target: Uint8Array, f: (typeof frames)[number]): void => {
    const { dims, patch } = f;
    for (let y = 0; y < dims.height; y++) {
      for (let x = 0; x < dims.width; x++) {
        const si = (y * dims.width + x) * 4;
        if (patch[si + 3] === 0) continue; // transparent -> board shows through
        const di = ((dims.top + y) * width + (dims.left + x)) * 4;
        target[di] = patch[si];
        target[di + 1] = patch[si + 1];
        target[di + 2] = patch[si + 2];
        target[di + 3] = 255;
      }
    }
  };
  const base = new Uint8Array(width * height * 4);
  const canvases: Uint8Array[] = [];
  frames.forEach((f, i) => {
    if (i === 0) {
      applyPatch(base, f); // the blank board base (persists via DisposalNone)
      canvases.push(base.slice());
    } else {
      const canvas = base.slice(); // DISPOSAL_PREVIOUS → restore to the blank base
      applyPatch(canvas, f);
      canvases.push(canvas);
    }
  });
  return canvases;
}

/** Count columns in [x0,x1) that contain >=1 white (digit) pixel in [y0,y1). */
function inkedWidth(canvas: Uint8Array, width: number, x0: number, x1: number, y0: number, y1: number): number {
  const [wr, wg, wb] = parseHexTriplet(COLORS.digit);
  let count = 0;
  for (let x = x0; x < x1; x++) {
    let inked = false;
    for (let y = y0; y < y1; y++) {
      const i = (y * width + x) * 4;
      if (Math.abs(canvas[i] - wr) <= 8 && Math.abs(canvas[i + 1] - wg) <= 8 && Math.abs(canvas[i + 2] - wb) <= 8) {
        inked = true;
        break;
      }
    }
    if (inked) count++;
  }
  return count;
}

/**
 * Decode the tens/ones digit values in a slot by measuring the inked width in
 * each half (tens in the left half, ones in the right). Because digit N has
 * width 20 + 3N, `(inkedWidth - 20) / 3` recovers N. Ghosting (leftover ink
 * from a wider previous digit) inflates the width and yields a wrong value.
 */
function decodeSlotDigits(
  canvas: Uint8Array,
  width: number,
  slotX: number,
): {
  tens: number;
  ones: number;
} {
  const center = slotX + Math.floor(POS.slotW / 2);
  const y0 = POS.slotY;
  const y1 = POS.slotY + POS.slotH;
  const tensW = inkedWidth(canvas, width, slotX, center, y0, y1);
  const onesW = inkedWidth(canvas, width, center, slotX + POS.slotW, y0, y1);
  return { tens: (tensW - 20) / 3, ones: (onesW - 20) / 3 };
}

describe('renderCountdownGif — positional correctness + no ghosting', () => {
  it('renders the correct digit in every slot on every frame (sheet pos != slot pos, variable widths)', () => {
    // Arrange — 1d 2h 3m 45s. Days/hours/minutes stay constant; seconds tick
    // down every frame (each a wide->narrower ones digit, which would ghost if
    // disposal were wrong).
    const remainingMs = 1 * 86_400_000 + 2 * 3_600_000 + 3 * 60_000 + 45_000;
    const fx = makePositionalFixture(remainingMs);

    // Act
    const { gifBytes } = renderCountdownGif(
      fx.board,
      fx.digits,
      fx.boardBoxes,
      fx.digitsBoxes,
      fx.colors,
      fx.remainingMs,
    );
    const canvases = compositeFrames(gifBytes, POS.boardW, POS.boardH);

    // Assert — canvases[0] is the BLANK board; the digit frames start at
    // canvases[1] (= frameTimes[0] = the current second). Decode each slot on
    // the first several digit frames and require the EXACT expected digit. A
    // wrong slot (coordinate mismatch / offset) or ghost ink (bad disposal)
    // makes the decoded value wrong.
    expect(canvases.length).toBeGreaterThan(6);
    const slots: ReadonlyArray<[keyof ReturnType<typeof expectedFragments>, number]> = [
      ['days', 0],
      ['hours', 1],
      ['minutes', 2],
      ['seconds', 3],
    ];
    for (let f = 0; f < 6; f++) {
      const exp = expectedFragments(remainingMs - f * 1000);
      // Digit frame for the f-th second is GIF frame index f + 1 (frame 0 = blank).
      const canvas = canvases[f + 1];
      for (const [unit, idx] of slots) {
        const val = exp[unit];
        const got = decodeSlotDigits(canvas, POS.boardW, POS.slotXs[idx]);
        expect(got.tens, `digit frame ${f} ${unit} tens`).toBe(Math.floor(val / 10) % 10);
        expect(got.ones, `digit frame ${f} ${unit} ones`).toBe(val % 10);
      }
    }
  });
});

// --- Two-width scheme: padded sprites overlap at the seam --------------------
//
// Guards the TWO-WIDTH capture change. Digit sprites are captured WIDER than the
// board half-slot (symmetric padding, so an italic glyph's ink is sliced whole).
// `placeDigitRects` centres each sprite on its half-slot, so the tens and ones
// sprites OVERLAP by 2·pad around the slot seam. `drawDigitFrames` composites
// them with `skipTransparent`, so the second sprite's transparent padding must
// NOT erase the first sprite's ink where they overlap.

describe('renderCountdownGif — two-width overlap (padded sprites, no seam erasure)', () => {
  it('keeps the tens ink where the ones sprite transparent padding overlaps it', () => {
    // Arrange — slot 40 (half-slot 20), sprite 30 (= advance 20 + 2·5 pad). Each
    // probe sprite is TRANSPARENT except a white ink bar at local x [18,27).
    //   placeDigitRects centres each sprite on its half-slot:
    //     tensRect.minX = fx + round((20 - 30)/2) = fx - 5  -> [fx-5, fx+25)
    //     onesRect.minX = fx + 20 + (-5)          = fx + 15 -> [fx+15, fx+45)
    //   Overlap = [fx+15, fx+25).
    //   In board x [fx+15, fx+20):
    //     - tens sprite local = boardX - (fx-5) -> [20,25) -> INSIDE the ink bar
    //       -> tens paints white here.
    //     - ones sprite local = boardX - (fx+15) -> [0,5)  -> OUTSIDE the ink bar
    //       -> ones is TRANSPARENT here, and is drawn AFTER tens.
    //   Without skipTransparent the ones padding overwrites the tens ink with the
    //   board color (inked width -> 0). With it, the tens ink survives (== 5).
    const SLOT_W = 40;
    const SLOT_H = 30;
    const SLOT_Y = 5;
    const SPRITE_W = 30;
    const SPRITE_H = 30;
    const INK_X0 = 18;
    const INK_X1 = 27;
    const boardW = 260;
    const boardH = 40;
    const slotXs = [10, 70, 130, 190];

    const [br, bgc, bb] = parseHexTriplet(COLORS.board);
    const board = new Uint8Array(boardW * boardH * 4);
    for (let i = 0; i < boardW * boardH; i++) {
      board[i * 4] = br;
      board[i * 4 + 1] = bgc;
      board[i * 4 + 2] = bb;
      board[i * 4 + 3] = 255;
    }

    // Digit sheet: 10 identical probe sprites (value-independent), each a white
    // vertical bar at local x [18,27) on a transparent field.
    const sheetW = SPRITE_W * 10;
    const [dr, dg, db] = parseHexTriplet(COLORS.digit);
    const digitsSheet = new Uint8Array(sheetW * SPRITE_H * 4);
    for (let n = 0; n < 10; n++) {
      for (let y = 0; y < SPRITE_H; y++) {
        for (let x = INK_X0; x < INK_X1; x++) {
          const i = (y * sheetW + n * SPRITE_W + x) * 4;
          digitsSheet[i] = dr;
          digitsSheet[i + 1] = dg;
          digitsSheet[i + 2] = db;
          digitsSheet[i + 3] = 255;
        }
      }
    }

    const units = ['days', 'hours', 'minutes', 'seconds'] as const;
    const boardBoxes: BoundingBox[] = units.map((k, idx) => ({
      key: k,
      x: slotXs[idx],
      y: SLOT_Y,
      width: SLOT_W,
      height: SLOT_H,
    }));
    const digitsBoxes: BoundingBox[] = Array.from({ length: 10 }, (_, n) => ({
      key: `${n}`,
      x: n * SPRITE_W,
      y: 0,
      width: SPRITE_W,
      height: SPRITE_H,
    }));

    // Act — 1d 1h 1m 1s so every slot draws two probe sprites.
    const remainingMs = 1 * 86_400_000 + 1 * 3_600_000 + 1 * 60_000 + 1_000;
    const { gifBytes } = renderCountdownGif(
      { rgba: board, width: boardW, height: boardH },
      { rgba: digitsSheet, width: sheetW, height: SPRITE_H },
      boardBoxes,
      digitsBoxes,
      COLORS,
      remainingMs,
    );
    const canvases = compositeFrames(gifBytes, boardW, boardH);
    const frame = canvases[1]; // first digit frame

    // Assert — for the days slot, the tens ink in the overlap band [fx+15,fx+20)
    // survives (all 5 columns inked). A seam-erasure regression drops it to 0.
    const fx = slotXs[0];
    const seamTensInk = inkedWidth(frame, boardW, fx + 15, fx + 20, SLOT_Y, SLOT_Y + SLOT_H);
    expect(seamTensInk, 'tens ink in the seam overlap must survive skip-transparent').toBe(5);

    // Sanity — the ones OUTER ink (local [18,27) -> board [fx+33,fx+42)) is well
    // outside any overlap, so it is always present.
    const onesOuterInk = inkedWidth(frame, boardW, fx + 33, fx + 42, SLOT_Y, SLOT_Y + SLOT_H);
    expect(onesOuterInk, 'ones outer ink must be fully drawn').toBe(9);
  });

  it('blends a semi-transparent ones-sprite edge pixel against the tens ink already drawn, not the raw board color', () => {
    // Arrange — same geometry as the seam-erasure test above (slot 40, half-slot
    // 20, sprite 30 = advance 20 + 2*5 pad). Every probe sprite carries:
    //   - an OPAQUE white ink bar at local x [18,27) (same "tens ink" as above)
    //   - a SEMI-TRANSPARENT (alpha=128) RED probe at local x [1,4)
    // tensRect = [fx-5, fx+25), onesRect = [fx+15, fx+45) (see comment above).
    // The ones sprite's red probe (local [1,4) -> board [fx+16,fx+19)) lands
    // INSIDE tens' ink band (board [fx+13,fx+22)), so at those board columns:
    //   - tens draws FIRST: opaque white ink (alpha=255 skips the blend branch
    //     entirely -> result is always pure white regardless of background).
    //   - ones draws SECOND: its red@alpha=128 pixel there MUST blend against
    //     whatever tens just painted (white), not the raw board color (navy) —
    //     compositing it against the blank board `bg` instead of the
    //     in-progress `frame` would erase the tens ink with a navy-tinted patch.
    // Blending red(255,0,0)@a=128 over WHITE gives high G/B (~127); over the
    // navy board (#1a2b3c) gives low G/B (~21,30) — the two cases are far
    // apart even after 256-color quantization, so this is a robust probe.
    const SLOT_W = 40;
    const SLOT_H = 30;
    const SLOT_Y = 5;
    const SPRITE_W = 30;
    const SPRITE_H = 30;
    const INK_X0 = 18;
    const INK_X1 = 27;
    const PROBE_X0 = 1;
    const PROBE_X1 = 4;
    const boardW = 260;
    const boardH = 40;
    const slotXs = [10, 70, 130, 190];

    const [br, bgc, bb] = parseHexTriplet(COLORS.board);
    const board = new Uint8Array(boardW * boardH * 4);
    for (let i = 0; i < boardW * boardH; i++) {
      board[i * 4] = br;
      board[i * 4 + 1] = bgc;
      board[i * 4 + 2] = bb;
      board[i * 4 + 3] = 255;
    }

    // Digit sheet: 10 identical probe sprites (value-independent), each with a
    // white opaque ink bar AND a semi-transparent red probe on a transparent field.
    const sheetW = SPRITE_W * 10;
    const [dr, dg, db] = parseHexTriplet(COLORS.digit);
    const digitsSheet = new Uint8Array(sheetW * SPRITE_H * 4);
    for (let n = 0; n < 10; n++) {
      for (let y = 0; y < SPRITE_H; y++) {
        for (let x = INK_X0; x < INK_X1; x++) {
          const i = (y * sheetW + n * SPRITE_W + x) * 4;
          digitsSheet[i] = dr;
          digitsSheet[i + 1] = dg;
          digitsSheet[i + 2] = db;
          digitsSheet[i + 3] = 255;
        }
        for (let x = PROBE_X0; x < PROBE_X1; x++) {
          const i = (y * sheetW + n * SPRITE_W + x) * 4;
          digitsSheet[i] = 255; // red probe
          digitsSheet[i + 1] = 0;
          digitsSheet[i + 2] = 0;
          digitsSheet[i + 3] = 128; // semi-transparent
        }
      }
    }

    const units = ['days', 'hours', 'minutes', 'seconds'] as const;
    const boardBoxes: BoundingBox[] = units.map((k, idx) => ({
      key: k,
      x: slotXs[idx],
      y: SLOT_Y,
      width: SLOT_W,
      height: SLOT_H,
    }));
    const digitsBoxes: BoundingBox[] = Array.from({ length: 10 }, (_, n) => ({
      key: `${n}`,
      x: n * SPRITE_W,
      y: 0,
      width: SPRITE_W,
      height: SPRITE_H,
    }));

    // Act — 1d 1h 1m 1s so every slot draws two probe sprites.
    const remainingMs = 1 * 86_400_000 + 1 * 3_600_000 + 1 * 60_000 + 1_000;
    const { gifBytes } = renderCountdownGif(
      { rgba: board, width: boardW, height: boardH },
      { rgba: digitsSheet, width: sheetW, height: SPRITE_H },
      boardBoxes,
      digitsBoxes,
      COLORS,
      remainingMs,
    );
    const canvases = compositeFrames(gifBytes, boardW, boardH);
    const frame = canvases[1]; // first digit frame

    // Assert — sample a pixel inside the ones probe's overlap with tens' ink
    // (board x = fx+17, within the ones probe's board range [fx+16,fx+19) AND
    // the tens ink band [fx+13,fx+22)).
    const fx = slotXs[0];
    const sampleX = fx + 17;
    const sampleY = SLOT_Y + 10;
    const i = (sampleY * boardW + sampleX) * 4;
    const g = frame[i + 1];
    const b = frame[i + 2];

    expect(g, 'green channel must reflect blending against the tens ink (white), not the board').toBeGreaterThan(60);
    expect(b, 'blue channel must reflect blending against the tens ink (white), not the board').toBeGreaterThan(60);
  });
});
