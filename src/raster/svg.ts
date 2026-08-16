/**
 * SVG source for the two rasters the compositor consumes.
 *
 * Two invariants here are load-bearing, both inherited from the browser-capture
 * pipeline this module replaces. Breaking either produces a GIF that looks
 * subtly wrong rather than one that fails loudly:
 *
 *   1. **The board carries NO digits.** GIF frame 0 is the blank board and acts
 *      as the persistent base that every per-second frame composites over and
 *      restores to (`dispose: 3`). A digit baked into the board would show
 *      through every frame forever.
 *
 *   2. **Digits are drawn on full transparency.** `drawPaletted` blends each
 *      sprite's transparent pixels over the board colour, so a glyph's
 *      anti-aliased edge resolves against the board instead of against a white
 *      box. An opaque sheet background would paint a visible rectangle behind
 *      every digit.
 *
 * No font-family is declared anywhere: the rasteriser is configured with
 * exactly one font buffer and `loadSystemFonts: false`, so the default family
 * is the only family. That keeps output identical on every machine — a system
 * font leaking in is precisely the kind of "works here, wrong in CI" bug that
 * golden-image tests exist to catch.
 */

import type { BoardLayout, DigitSheetLayout } from './layout.js';
import { slotBaselineY } from './layout.js';
import type { CountdownDesign } from './options.js';

/**
 * Minimal XML text escape.
 *
 * Load-bearing: unit labels are caller-supplied (`?labelDays=…`), so an
 * unescaped `<` would let a request inject SVG into the document this module
 * hands the rasteriser. `params.ts` also rejects control characters, which XML
 * cannot represent at all.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The board: background, optional border, dividers and labels — and four empty
 * digit slots.
 */
export function buildBoardSvg(design: CountdownDesign, layout: BoardLayout): string {
  const { width, height, cornerRadius, borderInset } = layout;
  const parts: string[] = [];

  // Background + border share one rect. When the board is transparent we still
  // emit the rect if there's a border to draw, with `fill="none"`.
  const hasFill = design.boardBackground !== 'transparent';
  const hasBorder = design.borderWidth > 0;

  if (hasFill || hasBorder) {
    const inset = borderInset;
    const rectW = width - design.borderWidth;
    const rectH = height - design.borderWidth;
    const fill = hasFill ? escapeXml(design.boardBackground) : 'none';
    const stroke = hasBorder
      ? ` stroke="${escapeXml(design.borderColor)}" stroke-width="${design.borderWidth}"`
      : '';
    const radius = cornerRadius > 0 ? ` rx="${cornerRadius}" ry="${cornerRadius}"` : '';
    parts.push(
      `<rect x="${inset}" y="${inset}" width="${rectW}" height="${rectH}"${radius} fill="${fill}"${stroke}/>`,
    );
  }

  // Dividers sit in the gaps between slots.
  if (design.dividerStyle !== 'space') {
    const radius =
      design.dividerStyle === 'colon'
        ? Math.max(1, Math.round(design.fontSize * 0.055))
        : Math.max(1, Math.round(design.fontSize * 0.07));
    const offset = Math.round(design.fontSize * 0.2);
    for (const centre of layout.dividerCentres) {
      if (design.dividerStyle === 'colon') {
        parts.push(dot(centre.x, centre.y - offset, radius, design.digitColor));
        parts.push(dot(centre.x, centre.y + offset, radius, design.digitColor));
      } else {
        parts.push(dot(centre.x, centre.y, radius, design.digitColor));
      }
    }
  }

  // Tracking comes from the layout, which used the same value to reserve the
  // label's width. Recomputing it here is how the drawn text and the space
  // reserved for it drift apart.
  const letterSpacing = Math.max(0, layout.labelLetterSpacing).toFixed(2);
  for (const label of layout.labels) {
    parts.push(
      `<text x="${label.centreX}" y="${label.baselineY}" font-size="${layout.labelFontSize}"` +
        ` fill="${escapeXml(design.labelColor)}" text-anchor="middle"` +
        ` letter-spacing="${letterSpacing}">${escapeXml(label.text)}</text>`,
    );
  }

  return svgDocument(width, height, parts.join(''));
}

/**
 * The digit sheet: glyphs `0`-`9` in one row of equal-width cells, each centred
 * on its cell so the exact monospace advance never has to be read from the font.
 */
export function buildDigitsSvg(design: CountdownDesign, sheet: DigitSheetLayout): string {
  const baselineY = slotBaselineY(design.fontSize);
  const parts: string[] = [];

  for (const cell of sheet.cells) {
    const centreX = cell.x + cell.width / 2;
    parts.push(
      `<text x="${centreX}" y="${baselineY}" font-size="${design.fontSize}"` +
        ` fill="${escapeXml(design.digitColor)}" text-anchor="middle">${escapeXml(cell.key)}</text>`,
    );
  }

  return svgDocument(sheet.width, sheet.height, parts.join(''));
}

function dot(cx: number, cy: number, r: number, fill: string): string {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${escapeXml(fill)}"/>`;
}

function svgDocument(width: number, height: number, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"` +
    ` viewBox="0 0 ${width} ${height}">${body}</svg>`
  );
}
