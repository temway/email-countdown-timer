import { describe, expect, it } from 'vitest';
import { layoutBoard } from '../raster/layout.js';
import {
  DEFAULT_DESIGN,
  DIVIDER_STYLES,
  resolveUnitLabel,
  UNIT_NAMES,
  type CountdownDesign,
  type DividerStyle,
  type UnitLabelOverrides,
  type UnitName,
} from '../raster/options.js';
import { MAX_FONT_SIZE, MAX_LABEL_LENGTH, MIN_FONT_SIZE } from '../params.js';
import { boardCssWidth } from './board-width.js';

/** Every legal font size — derived from the params bounds, as layout.test.ts does. */
const ALL_SIZES = Array.from(
  { length: MAX_FONT_SIZE - MIN_FONT_SIZE + 1 },
  (_, i) => MIN_FONT_SIZE + i,
);

/**
 * All 15 non-empty unit subsets, each in `UNIT_NAMES` order the way the parser
 * normalises them — `days+seconds` is real (untick the middle two) and renders
 * DAYS and SEC adjacent, so the pair-wise divider arithmetic sees it too.
 */
const ALL_SUBSETS: ReadonlyArray<readonly UnitName[]> = Array.from(
  { length: (1 << UNIT_NAMES.length) - 1 },
  (_, mask) => UNIT_NAMES.filter((_, bit) => (mask + 1) & (1 << bit)),
);

function design(overrides: Partial<CountdownDesign> = {}): CountdownDesign {
  return { ...DEFAULT_DESIGN, ...overrides };
}

/** The caption set the CLIENT must resolve before calling `boardCssWidth`. */
function resolvedLabelTexts(d: CountdownDesign): string[] {
  return d.showLabels ? d.units.map((unit) => resolveUnitLabel(unit, d.unitLabels)) : [];
}

function fill(text: string): UnitLabelOverrides {
  return Object.fromEntries(UNIT_NAMES.map((unit) => [unit, text]));
}

/** A spread of caption situations: defaults, per-unit overrides, the parser's longest. */
const CAPTION_SETS: ReadonlyArray<{ name: string; unitLabels: UnitLabelOverrides }> = [
  { name: 'defaults', unitLabels: {} },
  { name: 'one override', unitLabels: { days: 'JOURS' } },
  { name: 'mixed', unitLabels: { days: 'JOURS', minutes: 'MIN', seconds: 'S' } },
  { name: 'blank means default', unitLabels: { days: '   ' } },
  { name: 'longest', unitLabels: fill('W'.repeat(MAX_LABEL_LENGTH)) },
];

describe('boardCssWidth matches layoutBoard', () => {
  /**
   * The builder predicts board width WITHOUT rendering, by running the same
   * arithmetic the server trusts. If the two drift, the builder either blocks a
   * URL the server would happily render or ships one that 400s — both worse
   * than the reactive error this function exists to replace. So every case the
   * parser can produce is asserted here, not a sample.
   */
  it('agrees at every legal font size, divider, border and caption set (4 units)', () => {
    expect(ALL_SIZES.length).toBeGreaterThan(100); // non-vacuity
    for (const fontSize of ALL_SIZES) {
      for (const dividerStyle of DIVIDER_STYLES) {
        for (const borderWidth of [0, 24]) {
          for (const captions of CAPTION_SETS) {
            const d = design({ fontSize, dividerStyle, borderWidth, unitLabels: captions.unitLabels });
            const expected = layoutBoard(d).width;
            expect(
              boardCssWidth(fontSize, d.units.length, resolvedLabelTexts(d), dividerStyle, borderWidth),
              `fontSize=${fontSize} divider=${dividerStyle} border=${borderWidth} captions=${captions.name}`,
            ).toBe(expected);
          }
        }
      }
    }
  });

  it('agrees for every unit subset at sample sizes', () => {
    expect(ALL_SUBSETS).toHaveLength(15); // non-vacuity: 2^4 − 1 non-empty subsets
    for (const units of ALL_SUBSETS) {
      for (const fontSize of [MIN_FONT_SIZE, 37, 48, 80, MAX_FONT_SIZE]) {
        for (const captions of CAPTION_SETS) {
          const d = design({ units: [...units], fontSize, unitLabels: captions.unitLabels });
          expect(
            boardCssWidth(fontSize, units.length, resolvedLabelTexts(d), d.dividerStyle, d.borderWidth),
            `units=${units.join('+')} fontSize=${fontSize} captions=${captions.name}`,
          ).toBe(layoutBoard(d).width);
        }
      }
    }
  });

  /**
   * The contract: labels-off means `labelTexts: []`, never live texts. Passing
   * texts while labels are off would count `f * 0.02` letter-spacing and the
   * 8px caption floor that `layoutBoard` skips (layout.ts:147-149), predicting
   * too wide. Asserted across every size so the equivalence is not a spot check.
   */
  it('treats an empty caption list exactly like labels-off, at every size', () => {
    for (const fontSize of ALL_SIZES) {
      for (const dividerStyle of DIVIDER_STYLES) {
        const d = design({ fontSize, dividerStyle, showLabels: false });
        expect(
          boardCssWidth(fontSize, d.units.length, [], dividerStyle, d.borderWidth),
          `fontSize=${fontSize} divider=${dividerStyle}`,
        ).toBe(layoutBoard(d).width);
      }
    }
  });
});

describe('the numbers from the bug report, pinned', () => {
  /**
   * The reported mobile failure centred on the 1200-device-px ceiling. These
   * three sizes are the boundary the builder's live "max" hint quotes, so they
   * are pinned by name: 48 is the default (and fits), 80 is the first size
   * that does not fit at 2x with four units, 79 is the largest that does.
   */
  it('renders the default board at 362 CSS px, 724 device px', () => {
    expect(boardCssWidth(48, 4, ['DAYS', 'HRS', 'MIN', 'SEC'], 'colon', 0)).toBe(362);
    expect(boardCssWidth(48, 4, ['DAYS', 'HRS', 'MIN', 'SEC'], 'colon', 0) * 2).toBe(724);
  });

  it('puts size 80 just over the limit at 2x (1208 device px)', () => {
    expect(boardCssWidth(80, 4, ['DAYS', 'HRS', 'MIN', 'SEC'], 'colon', 0)).toBe(604);
    expect(boardCssWidth(80, 4, ['DAYS', 'HRS', 'MIN', 'SEC'], 'colon', 0) * 2).toBe(1208);
  });

  it('keeps size 79 just under it (1182 device px) — the live max the hint quotes', () => {
    expect(boardCssWidth(79, 4, ['DAYS', 'HRS', 'MIN', 'SEC'], 'colon', 0)).toBe(591);
    expect(boardCssWidth(79, 4, ['DAYS', 'HRS', 'MIN', 'SEC'], 'colon', 0) * 2).toBe(1182);
  });
});
