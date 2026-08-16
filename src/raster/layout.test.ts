import { describe, expect, it } from 'vitest';
import { digitAdvance, estimateLabelWidth, layoutBoard, layoutDigitSheet } from './layout.js';
import { DEFAULT_DESIGN, UNIT_LABELS, UNIT_NAMES, type CountdownDesign } from './options.js';
import { MAX_FONT_SIZE, MAX_LABEL_LENGTH, MIN_FONT_SIZE } from '../params.js';

/**
 * Every legal font size, so a rounding bug at one size cannot hide behind a
 * spot check at 48. Derived from the params bounds rather than hand-listed, so
 * widening the bounds automatically widens the test.
 */
const ALL_SIZES = Array.from(
  { length: MAX_FONT_SIZE - MIN_FONT_SIZE + 1 },
  (_, i) => MIN_FONT_SIZE + i,
);

function design(overrides: Partial<CountdownDesign> = {}): CountdownDesign {
  return { ...DEFAULT_DESIGN, ...overrides };
}

/** The same caption on every unit — derived, so a new unit is covered too. */
function fill(text: string): Record<string, string> {
  return Object.fromEntries(UNIT_NAMES.map((unit) => [unit, text]));
}

describe('the contract with the compositor', () => {
  /**
   * THE load-bearing invariant of this package.
   *
   * `placeDigitRects` centres each sprite on a half-slot:
   *     halfW = floor(slot.width / 2)
   *     x     = slot.x + round((halfW - sprite.width) / 2)
   * so when `sprite.width === halfW` the sprites tile the slot exactly, with no
   * overlap and no sub-pixel drift. Break this and digits creep sideways as the
   * font size changes — a failure that renders "fine" at a glance and wrong on
   * inspection, which is exactly why it is asserted rather than assumed.
   */
  it('makes a slot exactly two digit cells wide at every legal font size', () => {
    expect(ALL_SIZES.length).toBeGreaterThan(100); // non-vacuity

    for (const fontSize of ALL_SIZES) {
      const board = layoutBoard(design({ fontSize }));
      const sheet = layoutDigitSheet(fontSize);

      for (const slot of board.slots) {
        const halfW = Math.floor(slot.width / 2);
        for (const cell of sheet.cells) {
          expect(cell.width, `fontSize=${fontSize} slot=${slot.key}`).toBe(halfW);
        }
      }
    }
  });

  it('gives the digit sheet the same row height as a board slot', () => {
    for (const fontSize of ALL_SIZES) {
      const board = layoutBoard(design({ fontSize }));
      const sheet = layoutDigitSheet(fontSize);
      for (const slot of board.slots) {
        expect(slot.height, `fontSize=${fontSize}`).toBe(sheet.height);
      }
    }
  });

  it('emits bare box keys the compositor recognises', () => {
    const board = layoutBoard(design());
    const sheet = layoutDigitSheet(DEFAULT_DESIGN.fontSize);

    // `normalizeBoxes` matches on these exact child keys and drops anything else.
    expect(board.slots.map((s) => s.key)).toEqual([...UNIT_NAMES]);
    expect(sheet.cells.map((c) => c.key)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });
});

describe('board geometry', () => {
  it('keeps every slot inside the board', () => {
    for (const fontSize of [MIN_FONT_SIZE, 24, 48, 96, MAX_FONT_SIZE]) {
      for (const borderWidth of [0, 4, 24]) {
        for (const showLabels of [true, false]) {
          const layout = layoutBoard(design({ fontSize, borderWidth, showLabels }));
          for (const slot of layout.slots) {
            expect(slot.x).toBeGreaterThanOrEqual(borderWidth);
            expect(slot.y).toBeGreaterThanOrEqual(borderWidth);
            expect(slot.x + slot.width).toBeLessThanOrEqual(layout.width - borderWidth);
            expect(slot.y + slot.height).toBeLessThanOrEqual(layout.height - borderWidth);
          }
        }
      }
    }
  });

  it('lays slots left to right without overlapping', () => {
    const layout = layoutBoard(design());
    for (let i = 1; i < layout.slots.length; i++) {
      const prev = layout.slots[i - 1];
      const cur = layout.slots[i];
      expect(cur.x).toBeGreaterThanOrEqual(prev.x + prev.width);
    }
  });

  it('narrows the board as units are dropped', () => {
    const four = layoutBoard(design({ units: UNIT_NAMES }));
    const two = layoutBoard(design({ units: ['minutes', 'seconds'] }));
    const one = layoutBoard(design({ units: ['seconds'] }));

    expect(two.width).toBeLessThan(four.width);
    expect(one.width).toBeLessThan(two.width);
    expect(one.slots).toHaveLength(1);
    expect(one.dividerCentres).toHaveLength(0);
  });

  it('puts one divider in each gap between slots', () => {
    for (const units of [UNIT_NAMES, ['minutes', 'seconds'], ['seconds']] as const) {
      const layout = layoutBoard(design({ units: [...units] }));
      expect(layout.dividerCentres).toHaveLength(Math.max(0, units.length - 1));
    }
  });

  it('centres each divider between the slots it separates', () => {
    const layout = layoutBoard(design());
    layout.dividerCentres.forEach((centre, i) => {
      const left = layout.slots[i];
      const right = layout.slots[i + 1];
      expect(centre.x).toBeGreaterThan(left.x + left.width);
      expect(centre.x).toBeLessThan(right.x);
    });
  });

  it('reserves label space only when labels are on', () => {
    const withLabels = layoutBoard(design({ showLabels: true }));
    const without = layoutBoard(design({ showLabels: false }));

    expect(withLabels.height).toBeGreaterThan(without.height);
    expect(withLabels.labels).toHaveLength(UNIT_NAMES.length);
    expect(without.labels).toHaveLength(0);
  });

  it('draws labels below the digits, inside the board', () => {
    const layout = layoutBoard(design({ showLabels: true }));
    for (const label of layout.labels) {
      const slot = layout.slots.find((s) => Math.abs(s.x + s.width / 2 - label.centreX) <= 1);
      expect(slot).toBeDefined();
      expect(label.baselineY).toBeGreaterThan(slot!.y + slot!.height);
      expect(label.baselineY).toBeLessThanOrEqual(layout.height);
    }
  });

  it('only rounds corners for the rounded shape', () => {
    expect(layoutBoard(design({ shape: 'rounded' })).cornerRadius).toBeGreaterThan(0);
    expect(layoutBoard(design({ shape: 'rectangle' })).cornerRadius).toBe(0);
  });

  it('grows monotonically with font size', () => {
    let previous = 0;
    for (const fontSize of ALL_SIZES) {
      const { width } = layoutBoard(design({ fontSize }));
      expect(width).toBeGreaterThanOrEqual(previous);
      previous = width;
    }
  });
});

describe('custom captions', () => {
  /** Half the drawn width of a label, i.e. how far it reaches from its centre. */
  function halfLabelWidth(layout: ReturnType<typeof layoutBoard>, index: number): number {
    return (
      estimateLabelWidth(layout.labels[index].text, layout.labelFontSize, layout.labelLetterSpacing) /
      2
    );
  }

  /** The longest caption the parser will accept, at every legal font size. */
  const LONGEST = 'W'.repeat(MAX_LABEL_LENGTH);

  it('uses the override, and the default for every unit left out', () => {
    const layout = layoutBoard(design({ unitLabels: { days: 'JOURS' } }));
    expect(layout.labels.map((l) => l.text)).toEqual([
      'JOURS',
      UNIT_LABELS.hours,
      UNIT_LABELS.minutes,
      UNIT_LABELS.seconds,
    ]);
  });

  it('treats a blank override as unset rather than as an empty caption', () => {
    // One rule at both entry points: the URL layer strips empty values before
    // validation, so blank cannot mean anything else there either.
    expect(layoutBoard(design({ unitLabels: { days: '   ' } })).labels[0].text).toBe(UNIT_LABELS.days);
  });

  /**
   * The two ways a long caption breaks a board, and the reason the layout
   * reserves width for labels at all. Asserted at EVERY legal font size because
   * the reservation is arithmetic on rounded values — an off-by-one that only
   * bites at size 37 is exactly the kind of thing a spot check misses.
   */
  it('never lets a caption cross the board edge', () => {
    for (const fontSize of ALL_SIZES) {
      const layout = layoutBoard(design({ fontSize, unitLabels: fill(LONGEST) }));
      layout.labels.forEach((label, i) => {
        const half = halfLabelWidth(layout, i);
        expect(label.centreX - half, `fontSize=${fontSize} left edge`).toBeGreaterThanOrEqual(0);
        expect(label.centreX + half, `fontSize=${fontSize} right edge`).toBeLessThanOrEqual(
          layout.width,
        );
      });
    }
  });

  it('never lets two captions overlap', () => {
    for (const fontSize of ALL_SIZES) {
      const layout = layoutBoard(design({ fontSize, unitLabels: fill(LONGEST) }));
      expect(layout.labels.length).toBe(4); // non-vacuity
      for (let i = 1; i < layout.labels.length; i++) {
        const leftEnd = layout.labels[i - 1].centreX + halfLabelWidth(layout, i - 1);
        const rightStart = layout.labels[i].centreX - halfLabelWidth(layout, i);
        expect(rightStart, `fontSize=${fontSize} gap ${i}`).toBeGreaterThan(leftEnd);
      }
    }
  });

  it('keeps captions inside the border, not just inside the canvas', () => {
    const layout = layoutBoard(design({ borderWidth: 24, unitLabels: fill(LONGEST) }));
    layout.labels.forEach((label, i) => {
      const half = halfLabelWidth(layout, i);
      expect(label.centreX - half).toBeGreaterThanOrEqual(24);
      expect(label.centreX + half).toBeLessThanOrEqual(layout.width - 24);
    });
  });

  it('widens the board only as much as the caption needs', () => {
    const short = layoutBoard(design({ unitLabels: { days: 'D' } }));
    const long = layoutBoard(design({ unitLabels: fill(LONGEST) }));
    expect(long.width).toBeGreaterThan(short.width);
    // Vertical metrics are untouched — captions are one line either way.
    expect(long.height).toBe(short.height);
  });

  it('costs nothing when captions are off', () => {
    const plain = layoutBoard(design({ showLabels: false }));
    const custom = layoutBoard(design({ showLabels: false, unitLabels: fill(LONGEST) }));
    expect(custom.width).toBe(plain.width);
    expect(custom.labels).toHaveLength(0);
  });

  /**
   * The reservation must not silently re-flow boards nobody asked to change.
   * It does move two sizes, and that is a fix rather than a regression: below
   * 14px the 8px caption floor makes `DAYS` wider than its own slot, so the
   * default board used to draw captions all but touching.
   */
  it('leaves the default captions at their historical width above 13px', () => {
    const changed: number[] = [];
    for (const fontSize of ALL_SIZES) {
      const layout = layoutBoard(design({ fontSize }));
      const bare = layoutBoard(design({ fontSize, showLabels: false }));
      if (layout.width !== bare.width) changed.push(fontSize);
    }
    expect(changed).toEqual([12, 13]);
  });
});

describe('estimateLabelWidth', () => {
  it('over-estimates rather than under-estimates', () => {
    // Under-estimating clips a caption; over-estimating spends a pixel. The
    // trailing letter-space is counted deliberately for that reason.
    const spaced = estimateLabelWidth('ABC', 10, 2);
    const unspaced = estimateLabelWidth('ABC', 10, 0);
    expect(spaced).toBeGreaterThan(unspaced);
    expect(spaced - unspaced).toBe(6);
  });

  it('scales linearly with length, as a monospace font does', () => {
    expect(estimateLabelWidth('AA', 10, 1)).toBe(2 * estimateLabelWidth('A', 10, 1));
    expect(estimateLabelWidth('', 10, 1)).toBe(0);
  });
});

describe('digit sheet', () => {
  it('tiles ten equal cells with no gaps', () => {
    const sheet = layoutDigitSheet(48);
    expect(sheet.cells).toHaveLength(10);
    expect(sheet.width).toBe(sheet.advance * 10);

    sheet.cells.forEach((cell, i) => {
      expect(cell.x).toBe(i * sheet.advance);
      expect(cell.width).toBe(sheet.advance);
      expect(cell.y).toBe(0);
      expect(cell.height).toBe(sheet.height);
    });
  });

  it('keeps the baseline inside the cell', () => {
    for (const fontSize of ALL_SIZES) {
      const sheet = layoutDigitSheet(fontSize);
      expect(sheet.baselineY).toBeGreaterThan(0);
      expect(sheet.baselineY).toBeLessThanOrEqual(sheet.height);
    }
  });

  it('never produces a zero-width advance', () => {
    for (const fontSize of ALL_SIZES) {
      expect(digitAdvance(fontSize)).toBeGreaterThan(0);
    }
  });
});
