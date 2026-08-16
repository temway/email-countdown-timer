/**
 * Raster generation — the replacement for the headless-browser capture pre-pass.
 *
 * Produces the four inputs `renderCountdownGif` expects (board raster, digit
 * sprite sheet, and a bounding box array for each) entirely in-process via
 * resvg. No Chrome, no object storage, no database: this is what lets the whole
 * service run offline from a single container.
 *
 * The compositor's `normalizeBoxes` accepts BARE keys (`days`, `hours`,
 * `minutes`, `seconds`, `0`-`9`) and synthesises the parent `board` / `digits`
 * boxes from the image extent, so nothing here needs to emit prefixed keys or a
 * parent entry.
 */

import { Resvg } from '@resvg/resvg-js';
import { PNG } from 'pngjs';
import type { BoundingBox, CountdownColors, RasterImage } from '../render/compositor.js';
import { getFontFamily, getFontPath } from './fonts.js';
import { layoutBoard, layoutDigitSheet } from './layout.js';
import { TRANSPARENT_PALETTE_FALLBACK, type CountdownDesign, type Scale } from './options.js';
import { buildBoardSvg, buildDigitsSvg } from './svg.js';

/** The complete input set for one `renderCountdownGif` call. */
export interface CountdownArtifacts {
  readonly board: RasterImage;
  readonly digits: RasterImage;
  readonly boardBoxes: ReadonlyArray<BoundingBox>;
  readonly digitsBoxes: ReadonlyArray<BoundingBox>;
  /** Brand colours to merge into the palette, derived from the design. */
  readonly colors: CountdownColors;
}

/**
 * Render an SVG string to a decoded RGBA raster, `scale` device px per CSS px.
 *
 * The zoom happens in the RASTERISER, not in the SVG: glyph outlines are filled
 * at the target resolution, so a 2x render is genuinely sharper rather than an
 * upscale of a 1x one. Output is exactly `scale` times the document's px size
 * for integer scales, which is what lets the bounding boxes below be scaled by
 * plain multiplication.
 */
function rasterise(svg: string, scale: Scale): RasterImage {
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [getFontPath()],
      defaultFontFamily: getFontFamily(),
      // Determinism: never let a host font participate. See fonts.ts.
      loadSystemFonts: false,
    },
    fitTo: { mode: 'zoom', value: scale },
  });

  const png = PNG.sync.read(Buffer.from(resvg.render().asPng()));
  // pngjs returns a Buffer, which IS-A Uint8Array — the cast is free at runtime
  // and satisfies the compositor's `Uint8Array` contract with no copy.
  return { rgba: png.data as unknown as Uint8Array, width: png.width, height: png.height };
}

/**
 * Build every raster + box the compositor needs for one design.
 *
 * Deterministic and side-effect free: the same design always yields the same
 * bytes, which is what makes the render cache safe to key on the design alone.
 */
export function generateArtifacts(design: CountdownDesign): CountdownArtifacts {
  const boardLayout = layoutBoard(design);
  const sheetLayout = layoutDigitSheet(design.fontSize);

  // The layout is in CSS px; the rasters are in device px. Every box handed to
  // the compositor must be in the SAME space as the pixels it indexes into, so
  // both are scaled here rather than anywhere in `layout.ts` — which keeps the
  // geometry (and its tests) independent of the output resolution.
  const s = design.scale;

  const board = rasterise(buildBoardSvg(design, boardLayout), s);
  const digits = rasterise(buildDigitsSvg(design, sheetLayout), s);

  const boardBoxes: BoundingBox[] = boardLayout.slots.map((slot) => ({
    key: slot.key,
    x: slot.x * s,
    y: slot.y * s,
    width: slot.width * s,
    height: slot.height * s,
  }));

  const digitsBoxes: BoundingBox[] = sheetLayout.cells.map((cell) => ({
    key: cell.key,
    x: cell.x * s,
    y: cell.y * s,
    width: cell.width * s,
    height: cell.height * s,
  }));

  return {
    board,
    digits,
    boardBoxes,
    digitsBoxes,
    colors: {
      digit: design.digitColor,
      label: design.labelColor,
      // The palette cannot represent `'transparent'`; the raster is still drawn
      // with no fill, so this only decides which palette entry gets replaced.
      board:
        design.boardBackground === 'transparent'
          ? TRANSPARENT_PALETTE_FALLBACK
          : design.boardBackground,
      border: design.borderColor,
    },
  };
}
