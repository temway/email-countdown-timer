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
import { TRANSPARENT_PALETTE_FALLBACK, type CountdownDesign } from './options.js';
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

/** Render an SVG string to a decoded RGBA raster. */
function rasterise(svg: string): RasterImage {
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [getFontPath()],
      defaultFontFamily: getFontFamily(),
      // Determinism: never let a host font participate. See fonts.ts.
      loadSystemFonts: false,
    },
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

  const board = rasterise(buildBoardSvg(design, boardLayout));
  const digits = rasterise(buildDigitsSvg(design, sheetLayout));

  const boardBoxes: BoundingBox[] = boardLayout.slots.map((slot) => ({
    key: slot.key,
    x: slot.x,
    y: slot.y,
    width: slot.width,
    height: slot.height,
  }));

  const digitsBoxes: BoundingBox[] = sheetLayout.cells.map((cell) => ({
    key: cell.key,
    x: cell.x,
    y: cell.y,
    width: cell.width,
    height: cell.height,
  }));

  return {
    board,
    digits,
    boardBoxes,
    digitsBoxes,
    colors: {
      digit: design.digitColor,
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
