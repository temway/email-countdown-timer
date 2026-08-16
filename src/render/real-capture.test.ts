// Vitest test for the countdown GIF renderer against a REAL captured fixture.
//
// `compositor.test.ts` guards the compositing/quantization logic with
// SYNTHETIC in-process fixtures (built pixel-by-pixel in JS). Those never
// exercise a real Chrome-rendered, anti-aliased glyph — they can't catch a
// regression in how the renderer handles genuine anti-aliasing fringes
// through the 256-color GIF quantization.
//
// `__fixtures__/real-capture/` holds a REAL board.png/digits.png pair,
// captured locally via the actual Puppeteer capture path at production
// defaults (digitFontSize 48, Arial, default device scale factor).
// Regenerate by re-running the capture path locally if the capture markup
// or default styling changes.
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { type BoundingBox, type CountdownColors, type RasterImage, renderCountdownGif } from './compositor.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(MODULE_DIR, '__fixtures__', 'real-capture');
const GOLDEN_GIF_PATH = path.join(FIXTURE_DIR, 'golden.gif');
const GOLDEN_PNG_PATH = path.join(FIXTURE_DIR, 'golden.png');

/** A fixed remaining-time so the fixture's GIF bytes are deterministic. */
const REMAINING_MS = 1 * 86_400_000 + 2 * 3_600_000 + 22 * 60_000 + 37_000; // 1d 2h 22m 37s

function decodePng(buf: Buffer): RasterImage {
  const png = PNG.sync.read(buf);
  return { rgba: new Uint8Array(png.data), width: png.width, height: png.height };
}

function loadRealCaptureFixture(): {
  board: RasterImage;
  digits: RasterImage;
  boardBoxes: BoundingBox[];
  digitsBoxes: BoundingBox[];
  colors: CountdownColors;
} {
  const board = decodePng(readFileSync(path.join(FIXTURE_DIR, 'board.png')));
  const digits = decodePng(readFileSync(path.join(FIXTURE_DIR, 'digits.png')));
  const boardBoxes = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'boardBoxes.json'), 'utf8'));
  const digitsBoxes = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'digitsBoxes.json'), 'utf8'));
  const colors = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'colors.json'), 'utf8'));
  return { board, digits, boardBoxes, digitsBoxes, colors };
}

beforeAll(() => {
  if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });
});

describe('renderCountdownGif — real capture fixture (production defaults, real Chrome AA)', () => {
  it('renders a valid non-blank GIF from the real board/digits capture', () => {
    // Arrange
    const fixture = loadRealCaptureFixture();

    // Act
    const { gifBytes, pngBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      REMAINING_MS,
    );

    // Assert — sane, non-trivial output.
    expect(gifBytes.length).toBeGreaterThan(1000);
    expect(pngBytes.length).toBeGreaterThan(100);
    const header = Buffer.from(gifBytes.slice(0, 6)).toString('ascii');
    expect(header).toBe('GIF89a');
  });

  it('byte-identical to committed golden fixture (auto-regenerates on first run)', () => {
    // Arrange
    const fixture = loadRealCaptureFixture();

    // Act
    const { gifBytes, pngBytes } = renderCountdownGif(
      fixture.board,
      fixture.digits,
      fixture.boardBoxes,
      fixture.digitsBoxes,
      fixture.colors,
      REMAINING_MS,
    );

    // Assert — if golden files don't exist yet (first run, fresh clone), write
    //   them and pass. On subsequent runs, the new render must match the
    //   committed bytes exactly — guards against accidental algorithm drift
    //   AND against a future capture-side regression (e.g. a font-rendering
    //   or DSF change) if the fixture is ever regenerated deliberately.
    if (!existsSync(GOLDEN_GIF_PATH) || !existsSync(GOLDEN_PNG_PATH)) {
      writeFileSync(GOLDEN_GIF_PATH, Buffer.from(gifBytes));
      writeFileSync(GOLDEN_PNG_PATH, Buffer.from(pngBytes));
      console.warn(
        '[renderer.real-capture.test] golden fixture missing — wrote fresh bytes to',
        FIXTURE_DIR,
        '. Commit them (git add -f — __fixtures__ matches some global gitignore configs).',
      );
      return;
    }

    const goldenGif = readFileSync(GOLDEN_GIF_PATH);
    const goldenPng = readFileSync(GOLDEN_PNG_PATH);

    expect(
      Buffer.compare(Buffer.from(gifBytes), goldenGif),
      'fresh render must match committed golden.gif — if you intentionally changed the algorithm or re-captured the fixture, delete __fixtures__/real-capture/golden.{gif,png} and re-run',
    ).toBe(0);
    expect(Buffer.compare(Buffer.from(pngBytes), goldenPng), 'fresh PNG render must match committed golden.png').toBe(
      0,
    );
  });
});
