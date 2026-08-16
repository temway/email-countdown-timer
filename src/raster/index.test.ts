import { describe, expect, it } from 'vitest';
import { renderCountdownGif, type RasterImage } from '../render/compositor.js';
import { generateArtifacts } from './index.js';
import { layoutBoard } from './layout.js';
import {
  DEFAULT_DESIGN,
  SCALES,
  TRANSPARENT_PALETTE_FALLBACK,
  type CountdownDesign,
} from './options.js';

function design(overrides: Partial<CountdownDesign> = {}): CountdownDesign {
  return { ...DEFAULT_DESIGN, ...overrides };
}

function pixel(img: RasterImage, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]];
}

/** Count pixels close to `hex`, ignoring anti-aliased edges via a tolerance. */
function countNear(img: RasterImage, hex: string, tolerance = 24): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  let n = 0;
  for (let i = 0; i < img.rgba.length; i += 4) {
    if (img.rgba[i + 3] < 128) continue;
    if (
      Math.abs(img.rgba[i] - r) <= tolerance &&
      Math.abs(img.rgba[i + 1] - g) <= tolerance &&
      Math.abs(img.rgba[i + 2] - b) <= tolerance
    ) {
      n++;
    }
  }
  return n;
}

function countOpaque(img: RasterImage): number {
  let n = 0;
  for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] > 0) n++;
  return n;
}

describe('invariant 1: the board carries no digits', () => {
  /**
   * GIF frame 0 is the blank board and acts as the persistent base every
   * per-second frame restores to (`dispose: 3`). A digit baked into the board
   * would show through every frame for the life of the animation.
   *
   * Tested by rendering with a digit colour nowhere near the board colour and
   * asserting the slot interiors contain none of it.
   */
  it('leaves the digit slots empty', () => {
    const ink = '#ff0000';
    const { board, boardBoxes } = generateArtifacts(
      design({ digitColor: ink, boardBackground: '#000000', dividerStyle: 'space', showLabels: false }),
    );

    expect(boardBoxes.length).toBe(4); // non-vacuity: we actually inspected slots

    for (const slot of boardBoxes) {
      for (let y = slot.y; y < slot.y + slot.height; y++) {
        for (let x = slot.x; x < slot.x + slot.width; x++) {
          const [r, g, b] = pixel(board, x, y);
          expect(
            Math.abs(r - 255) > 40 || g > 40 || b > 40,
            `digit ink found in slot ${slot.key} at ${x},${y}`,
          ).toBe(true);
        }
      }
    }
  });

  it('still draws dividers and labels, which are not digits', () => {
    const ink = '#ff0000';
    const withChrome = generateArtifacts(
      design({ digitColor: ink, boardBackground: '#000000', dividerStyle: 'colon', showLabels: true }),
    );
    const without = generateArtifacts(
      design({ digitColor: ink, boardBackground: '#000000', dividerStyle: 'space', showLabels: false }),
    );

    expect(countNear(withChrome.board, ink)).toBeGreaterThan(0);
    expect(countNear(without.board, ink)).toBe(0);
  });
});

describe('invariant 2: digits are drawn on transparency', () => {
  /**
   * `drawPaletted` blends a sprite's transparent pixels over the board colour so
   * a glyph's anti-aliased edge resolves against the board. An opaque sheet
   * background would paint a visible rectangle behind every digit.
   */
  it('leaves the sheet background fully transparent', () => {
    const { digits } = generateArtifacts(design());

    // Corners are always outside a glyph.
    for (const [x, y] of [
      [0, 0],
      [digits.width - 1, 0],
      [0, digits.height - 1],
      [digits.width - 1, digits.height - 1],
    ]) {
      expect(pixel(digits, x, y)[3], `corner ${x},${y} should be transparent`).toBe(0);
    }

    // And most of the sheet is background, not ink.
    const opaque = countOpaque(digits);
    const total = digits.width * digits.height;
    expect(opaque).toBeGreaterThan(0);
    expect(opaque).toBeLessThan(total * 0.6);
  });

  it('renders ink in all ten digit cells', () => {
    const { digits, digitsBoxes } = generateArtifacts(design());
    expect(digitsBoxes).toHaveLength(10);

    for (const cell of digitsBoxes) {
      let ink = 0;
      for (let y = cell.y; y < cell.y + cell.height; y++) {
        for (let x = cell.x; x < cell.x + cell.width; x++) {
          if (pixel(digits, x, y)[3] > 0) ink++;
        }
      }
      expect(ink, `glyph "${cell.key}" rendered nothing`).toBeGreaterThan(0);
    }
  });
});

describe('board background', () => {
  it('produces transparent pixels when the board is transparent', () => {
    const { board } = generateArtifacts(design({ boardBackground: 'transparent', borderWidth: 0 }));
    // The compositor keys its GIF transparency flag off exactly this.
    const transparent = board.width * board.height - countOpaque(board);
    expect(transparent).toBeGreaterThan(0);
  });

  it('produces a fully opaque board when a colour is given', () => {
    const { board } = generateArtifacts(
      design({ boardBackground: '#1a1a2e', shape: 'rectangle', borderWidth: 0 }),
    );
    expect(countOpaque(board)).toBe(board.width * board.height);
  });

  it('substitutes a palette-safe colour for a transparent board', () => {
    // `parseHex` cannot consume the literal 'transparent'.
    const { colors } = generateArtifacts(design({ boardBackground: 'transparent' }));
    expect(colors.board).toBe(TRANSPARENT_PALETTE_FALLBACK);
  });

  it('passes the design colours through to the palette', () => {
    const { colors } = generateArtifacts(
      design({ digitColor: '#abcdef', labelColor: '#987654', boardBackground: '#123456', borderColor: '#fedcba' }),
    );
    expect(colors).toEqual({ digit: '#abcdef', label: '#987654', board: '#123456', border: '#fedcba' });
  });
});

describe('label colour', () => {
  /**
   * `labelColor` exists so captions can be dimmed against the digits. The
   * contract splits three ways: captions take `labelColor`; digits AND dividers
   * keep `digitColor`. The `space` divider isolates the caption ink from the
   * divider ink, so each assertion sees exactly one of the two.
   */
  it('paints captions in the label colour and nothing else', () => {
    const { board, digits } = generateArtifacts(
      design({
        digitColor: '#ff0000',
        labelColor: '#00ff00',
        boardBackground: '#000000',
        dividerStyle: 'space',
      }),
    );
    expect(countNear(board, '#00ff00')).toBeGreaterThan(0);
    expect(countNear(digits, '#00ff00')).toBe(0);
  });

  it('keeps dividers on the digit colour when the label colour differs', () => {
    const { board } = generateArtifacts(
      design({
        digitColor: '#ff0000',
        labelColor: '#00ff00',
        boardBackground: '#000000',
        dividerStyle: 'colon',
      }),
    );
    expect(countNear(board, '#ff0000')).toBeGreaterThan(0); // dividers
    expect(countNear(board, '#00ff00')).toBeGreaterThan(0); // captions
  });
});

describe('custom captions', () => {
  it('changes the raster, so a caption is really drawn', () => {
    const a = generateArtifacts(design({ unitLabels: { days: 'JOURS' } }));
    const b = generateArtifacts(design({ unitLabels: { days: 'TAGE' } }));
    expect(Buffer.from(a.board.rgba)).not.toEqual(Buffer.from(b.board.rgba));
  });

  it('resolves a blank override to the default caption, byte for byte', () => {
    const blank = generateArtifacts(design({ unitLabels: { days: '  ' } }));
    const plain = generateArtifacts(design());
    expect(Buffer.from(blank.board.rgba)).toEqual(Buffer.from(plain.board.rgba));
  });

  /**
   * The reason `layout.ts` reserves width for labels at all. A caption wider
   * than its slot must widen the board rather than run off it — verified on the
   * RASTER, because the layout arithmetic agreeing with itself proves nothing
   * about what resvg actually drew.
   */
  it('never paints caption ink into the outermost pixel columns', () => {
    const artifacts = generateArtifacts(
      design({
        digitColor: '#ff0000',
        boardBackground: '#000000',
        borderWidth: 0,
        unitLabels: { days: 'WWWWWWWWWWWW', hours: 'WWWWWWWWWWWW' },
      }),
    );
    const { board } = artifacts;

    // Ink touching column 0 or the last column means the caption was clipped.
    for (const x of [0, board.width - 1]) {
      for (let y = 0; y < board.height; y++) {
        const [r, g, b] = pixel(board, x, y);
        expect(r < 200 || g > 60 || b > 60, `caption ink at the board edge, x=${x} y=${y}`).toBe(true);
      }
    }
    // Non-vacuity: the captions did render somewhere.
    expect(countNear(board, '#ff0000')).toBeGreaterThan(0);
  });

  it('leaves the digit sheet untouched — captions are board furniture', () => {
    const a = generateArtifacts(design({ unitLabels: { days: 'JOURS' } }));
    const b = generateArtifacts(design());
    expect(Buffer.from(a.digits.rgba)).toEqual(Buffer.from(b.digits.rgba));
  });

  it('renders a playable GIF with captions in another language', () => {
    const a = generateArtifacts(
      design({ unitLabels: { days: 'TAGE', hours: 'STD', minutes: 'MIN', seconds: 'SEK' } }),
    );
    const out = renderCountdownGif(a.board, a.digits, a.boardBoxes, a.digitsBoxes, a.colors, 90_061_000);
    expect(Buffer.from(out.gifBytes.slice(0, 6)).toString('ascii')).toBe('GIF89a');
  });
});

describe('determinism', () => {
  /**
   * System fonts are disabled, so output must not depend on the host. If this
   * ever fails, a host font has crept into the render and every golden-image
   * test in this repo is meaningless.
   */
  it('renders identical bytes for identical designs', () => {
    const a = generateArtifacts(design());
    const b = generateArtifacts(design());
    expect(Buffer.from(a.board.rgba)).toEqual(Buffer.from(b.board.rgba));
    expect(Buffer.from(a.digits.rgba)).toEqual(Buffer.from(b.digits.rgba));
  });

  it('renders different bytes for different designs', () => {
    const a = generateArtifacts(design({ digitColor: '#ffffff' }));
    const b = generateArtifacts(design({ digitColor: '#ff0000' }));
    expect(Buffer.from(a.digits.rgba)).not.toEqual(Buffer.from(b.digits.rgba));
  });
});

describe('raster dimensions match the layout', () => {
  it('agrees with layoutBoard at every tested size and scale', () => {
    for (const scale of SCALES) {
      for (const fontSize of [12, 24, 48, 96, 160]) {
        const d = design({ fontSize, scale });
        const { board } = generateArtifacts(d);
        const layout = layoutBoard(d);
        // The layout is in CSS px, the raster in device px. Exactness matters:
        // the bounding boxes are scaled by plain multiplication, so a rasteriser
        // that rounded differently would slide every sprite off its slot.
        expect([board.width, board.height], `size=${fontSize} scale=${scale}`).toEqual([
          layout.width * scale,
          layout.height * scale,
        ]);
      }
    }
  });

  it('makes a 2x render exactly double a 1x one, boxes included', () => {
    // Odd layout dimensions are the interesting case — 367x128 must become
    // 734x256, not 736x256 from a rasteriser rounding up to an even size.
    const at1 = generateArtifacts(design({ fontSize: 49, scale: 1 }));
    const at2 = generateArtifacts(design({ fontSize: 49, scale: 2 }));

    expect([at2.board.width, at2.board.height]).toEqual([at1.board.width * 2, at1.board.height * 2]);
    expect([at2.digits.width, at2.digits.height]).toEqual([
      at1.digits.width * 2,
      at1.digits.height * 2,
    ]);

    expect(at1.boardBoxes.length).toBeGreaterThan(0); // non-vacuity
    for (const [i, box] of at2.boardBoxes.entries()) {
      const one = at1.boardBoxes[i];
      expect(box, one.key).toEqual({
        key: one.key,
        x: one.x * 2,
        y: one.y * 2,
        width: one.width * 2,
        height: one.height * 2,
      });
    }
  });

  it('keeps the compositor sprite invariant at every scale', () => {
    // `renderCountdownGif` centres one sprite on each half-slot, so a sprite
    // cell must be exactly half a slot or the digits drift. This is what
    // restricts `scale` to integers — see options.ts.
    for (const scale of SCALES) {
      for (const fontSize of [12, 13, 47, 48, 49, 160]) {
        const { boardBoxes, digitsBoxes } = generateArtifacts(design({ fontSize, scale }));
        expect(Math.floor(boardBoxes[0].width / 2), `size=${fontSize} scale=${scale}`).toBe(
          digitsBoxes[0].width,
        );
      }
    }
  });
});

describe('end to end through the compositor', () => {
  it('renders a playable GIF from generated artifacts', () => {
    const artifacts = generateArtifacts(design());
    const out = renderCountdownGif(
      artifacts.board,
      artifacts.digits,
      artifacts.boardBoxes,
      artifacts.digitsBoxes,
      artifacts.colors,
      3 * 86_400_000 + 4 * 3_600_000 + 5 * 60_000 + 6_000,
    );

    // GIF89a magic + a non-trivial payload.
    expect(Buffer.from(out.gifBytes.slice(0, 6)).toString('ascii')).toBe('GIF89a');
    expect(out.gifBytes.length).toBeGreaterThan(1000);
    // PNG magic.
    expect(Array.from(out.pngBytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('renders different bytes as the remaining time changes', () => {
    const artifacts = generateArtifacts(design());
    const render = (ms: number) =>
      renderCountdownGif(
        artifacts.board,
        artifacts.digits,
        artifacts.boardBoxes,
        artifacts.digitsBoxes,
        artifacts.colors,
        ms,
      ).gifBytes;

    expect(Buffer.from(render(60_000))).not.toEqual(Buffer.from(render(3_600_000)));
  });

  it('renders an expired timer without throwing', () => {
    const artifacts = generateArtifacts(design());
    const out = renderCountdownGif(
      artifacts.board,
      artifacts.digits,
      artifacts.boardBoxes,
      artifacts.digitsBoxes,
      artifacts.colors,
      0,
    );
    expect(out.gifBytes.length).toBeGreaterThan(0);
  });

  it('works for every unit subset', () => {
    for (const units of [
      ['days', 'hours', 'minutes', 'seconds'],
      ['hours', 'minutes', 'seconds'],
      ['minutes', 'seconds'],
      ['seconds'],
      ['days'],
    ] as const) {
      const d = design({ units: [...units] });
      const a = generateArtifacts(d);
      expect(a.boardBoxes).toHaveLength(units.length);
      const out = renderCountdownGif(a.board, a.digits, a.boardBoxes, a.digitsBoxes, a.colors, 90_061_000);
      expect(out.gifBytes.length, `units=${units.join(',')}`).toBeGreaterThan(0);
    }
  });
});
