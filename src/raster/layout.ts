/**
 * Pure geometry for the countdown board and the digit sprite sheet.
 *
 * No SVG, no rendering, no I/O — just numbers. Kept separate so the layout can
 * be unit-tested without a rasteriser, and so the SVG builder and the bounding
 * boxes handed to the compositor are guaranteed to be derived from the SAME
 * arithmetic (they used to come from a browser measuring a live DOM, which is
 * exactly the coupling this package exists to remove).
 *
 * ## The contract with the compositor
 *
 * `renderCountdownGif` treats each unit slot as **two tabular advances** wide
 * and centres one digit sprite on each half:
 *
 *     halfW   = floor(slot.width / 2)
 *     tensX   = slot.x + round((halfW - sprite.width) / 2)
 *     onesX   = slot.x + halfW + round((halfW - sprite.width) / 2)
 *
 * So when `sprite.width === halfW` the sprites land exactly on the half-slots
 * with no overlap and no rounding drift. We get that for free by deriving BOTH
 * from `digitAdvance`: a slot is `2 * digitAdvance` wide and a sprite cell is
 * `digitAdvance` wide. Keep that invariant — it is what lets this package skip
 * the overlapping two-width sprite scheme the browser capture needed.
 */

import { resolveUnitLabel, type CountdownDesign, type UnitName } from './options.js';

/** A rectangle in raster pixel coordinates, matching the compositor's `BoundingBox` shape. */
export interface Box {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BoardLayout {
  readonly width: number;
  readonly height: number;
  /** One slot per unit, in `design.units` order. Keys are bare unit names. */
  readonly slots: ReadonlyArray<Box & { key: UnitName }>;
  /** Centre points of the gaps between slots, for divider glyphs. */
  readonly dividerCentres: ReadonlyArray<{ x: number; y: number }>;
  /** Label baseline positions, one per slot (empty when labels are off). */
  readonly labels: ReadonlyArray<{ text: string; centreX: number; baselineY: number }>;
  readonly labelFontSize: number;
  /**
   * Tracking applied to label text. Lives here, not in the SVG builder, because
   * it feeds {@link estimateLabelWidth} — the width reservation and the drawn
   * text must be computed from the same number or the reservation is a guess.
   */
  readonly labelLetterSpacing: number;
  /** Inset of the border stroke's centreline, so SVG strokes don't clip. */
  readonly borderInset: number;
  readonly cornerRadius: number;
}

export interface DigitSheetLayout {
  readonly width: number;
  readonly height: number;
  /** One cell per glyph 0-9. Keys are bare digit characters. */
  readonly cells: ReadonlyArray<Box>;
  /** Baseline y for every glyph (they share one row). */
  readonly baselineY: number;
  readonly advance: number;
}

/**
 * Monospace advance as a fraction of font size.
 *
 * Noto Sans Mono is 600/1000 units per em. We do not read this from the font
 * file: every glyph is drawn with `text-anchor="middle"` at its cell centre, so
 * a small discrepancy shifts nothing — it only makes cells marginally loose or
 * tight. Correctness does not depend on this constant being exact.
 */
const ADVANCE_RATIO = 0.6;

/**
 * Figure (lining digit) height as a fraction of font size, used to centre the
 * digit row optically. Digits have no descenders, so centring on the cap/figure
 * box looks right where centring on the full em box looks bottom-heavy.
 */
const FIGURE_HEIGHT_RATIO = 0.71;

/** Vertical breathing room around the digit row, as a fraction of font size. */
const DIGIT_ROW_LEADING = 0.25;

/** Label tracking, as a fraction of font size. */
const LABEL_LETTER_SPACING_RATIO = 0.02;

/** Clearance kept between a label and the board edge, as a fraction of font size. */
const LABEL_EDGE_GAP_RATIO = 0.15;

/** Clearance kept between two adjacent labels, as a fraction of LABEL font size. */
const LABEL_MIN_GAP_RATIO = 0.6;

/**
 * Width of a label in px, without measuring the font.
 *
 * Sound because the one registered font is monospace: every glyph advances
 * `ADVANCE_RATIO` ems, so the width is arithmetic rather than metrics. Two
 * details make the error safe in the direction that matters:
 *
 *   - Trailing letter-spacing is counted whether or not the rasteriser emits
 *     it, and a surrogate pair counts as two units, so this OVER-estimates.
 *     Over-estimating reserves a pixel too much; under-estimating clips a
 *     caption, which is the failure this function exists to prevent.
 *   - A glyph missing from the font renders as nothing, i.e. narrower still.
 */
export function estimateLabelWidth(
  text: string,
  labelFontSize: number,
  letterSpacing: number,
): number {
  return text.length * (labelFontSize * ADVANCE_RATIO + letterSpacing);
}

export function digitAdvance(fontSize: number): number {
  return Math.round(fontSize * ADVANCE_RATIO);
}

export function digitRowHeight(fontSize: number): number {
  return Math.round(fontSize * (1 + DIGIT_ROW_LEADING));
}

/**
 * Baseline offset within a cell of `height`, placing the figure box's optical
 * centre on the cell's centre.
 */
function figureBaseline(height: number, fontSize: number): number {
  const figureHeight = fontSize * FIGURE_HEIGHT_RATIO;
  return Math.round((height + figureHeight) / 2);
}

export function layoutBoard(design: CountdownDesign): BoardLayout {
  const { fontSize, units, showLabels, borderWidth, dividerStyle, shape } = design;

  const advance = digitAdvance(fontSize);
  const slotW = advance * 2;
  const slotH = digitRowHeight(fontSize);

  const labelFontSize = Math.max(8, Math.round(fontSize * 0.26));
  const labelLetterSpacing = showLabels ? fontSize * LABEL_LETTER_SPACING_RATIO : 0;
  const labelGap = showLabels ? Math.round(fontSize * 0.16) : 0;
  const labelH = showLabels ? Math.round(labelFontSize * 1.3) : 0;

  const labelTexts = showLabels
    ? units.map((unit) => resolveUnitLabel(unit, design.unitLabels))
    : [];

  /**
   * How far each label sticks out past its slot, on one side.
   *
   * Labels are centred on their slot, so a caption wider than two digits
   * overhangs symmetrically. Left unhandled that clips at the board edge and
   * collides mid-board — the two ways a custom caption breaks. Both are fixed
   * by spending the overhang: on padding at the ends, on the divider gap in
   * between.
   */
  const overhang = labelTexts.map((text) =>
    Math.max(0, Math.ceil((estimateLabelWidth(text, labelFontSize, labelLetterSpacing) - slotW) / 2)),
  );

  // A `space` divider still needs a gap, just no glyph in it.
  const baseDividerW =
    dividerStyle === 'space' ? Math.round(fontSize * 0.3) : Math.round(fontSize * 0.55);
  const minLabelGap = showLabels ? Math.round(labelFontSize * LABEL_MIN_GAP_RATIO) : 0;

  // One uniform gap, sized for the tightest pair — slots must stay evenly
  // spaced, so a single wide caption widens every gap, not just its own.
  let dividerW = baseDividerW;
  for (let i = 1; i < overhang.length; i++) {
    dividerW = Math.max(dividerW, overhang[i - 1] + overhang[i] + minLabelGap);
  }

  const edgeOverhang = overhang.length ? Math.max(overhang[0], overhang[overhang.length - 1]) : 0;
  const padX = Math.max(
    Math.round(fontSize * 0.55),
    edgeOverhang + Math.round(fontSize * LABEL_EDGE_GAP_RATIO),
  );
  const padY = Math.round(fontSize * 0.42);

  const innerW = units.length * slotW + Math.max(0, units.length - 1) * dividerW;
  const innerH = slotH + labelGap + labelH;

  const width = borderWidth * 2 + padX * 2 + innerW;
  const height = borderWidth * 2 + padY * 2 + innerH;

  const originX = borderWidth + padX;
  const originY = borderWidth + padY;

  const slots = units.map((unit, i) => ({
    key: unit,
    x: originX + i * (slotW + dividerW),
    y: originY,
    width: slotW,
    height: slotH,
  }));

  const dividerCentres = slots.slice(0, -1).map((slot) => ({
    x: slot.x + slot.width + Math.round(dividerW / 2),
    y: originY + Math.round(slotH / 2),
  }));

  // `labelTexts` is empty when labels are off, so this yields no entries then.
  const labels = labelTexts.map((text, i) => ({
    text,
    centreX: slots[i].x + Math.round(slots[i].width / 2),
    baselineY: originY + slotH + labelGap + labelFontSize,
  }));

  return {
    width,
    height,
    slots,
    dividerCentres,
    labels,
    labelFontSize,
    labelLetterSpacing,
    borderInset: borderWidth / 2,
    cornerRadius: shape === 'rounded' ? Math.round(fontSize * 0.25) : 0,
  };
}

export function layoutDigitSheet(fontSize: number): DigitSheetLayout {
  const advance = digitAdvance(fontSize);
  const height = digitRowHeight(fontSize);

  const cells: Box[] = [];
  for (let d = 0; d <= 9; d++) {
    cells.push({ key: String(d), x: d * advance, y: 0, width: advance, height });
  }

  return {
    width: advance * 10,
    height,
    cells,
    baselineY: figureBaseline(height, fontSize),
    advance,
  };
}

/** Digit baseline inside a board slot — shares the sheet's vertical metrics. */
export function slotBaselineY(fontSize: number): number {
  return figureBaseline(digitRowHeight(fontSize), fontSize);
}
