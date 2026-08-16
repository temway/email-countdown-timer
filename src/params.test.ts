import { describe, expect, it } from 'vitest';
import {
  MAX_FONT_SIZE,
  MAX_LABEL_LENGTH,
  MIN_FONT_SIZE,
  countdownParamsSchema,
  parseCountdownParams,
  unitLabelParam,
} from './params.js';
import {
  DEFAULT_DESIGN,
  DIVIDER_STYLES,
  SHAPES,
  UNIT_LABELS,
  UNIT_NAMES,
  resolveUnitLabel,
} from './raster/options.js';

const UNTIL = '2026-12-25T00:00:00.000Z';

function parse(query: Record<string, string | undefined>) {
  return parseCountdownParams({ until: UNTIL, ...query });
}

function ok(query: Record<string, string | undefined> = {}) {
  const result = parse(query);
  if (!result.ok) throw new Error(`expected parse to succeed: ${result.error}`);
  return result.value;
}

function err(query: Record<string, string | undefined>): string {
  const result = parseCountdownParams(query);
  if (result.ok) throw new Error('expected parse to fail');
  return result.error;
}

describe('until', () => {
  it('is required', () => {
    expect(err({})).toMatch(/until/);
  });

  it('parses an ISO timestamp to epoch ms', () => {
    expect(ok().endsAt).toBe(Date.parse(UNTIL));
  });

  it('rejects an unparseable date', () => {
    expect(err({ until: 'next tuesday' })).toMatch(/date/);
  });

  it('accepts a past date — expiry is the renderer\'s business, not the parser\'s', () => {
    expect(ok({ until: '2000-01-01T00:00:00Z' }).endsAt).toBeLessThan(Date.now());
  });
});

describe('defaults', () => {
  it('produces the default design from `until` alone', () => {
    expect(ok().design).toEqual(DEFAULT_DESIGN);
  });

  it('treats an empty string as absent so the default applies', () => {
    expect(ok({ size: '', divider: '' }).design).toEqual(DEFAULT_DESIGN);
  });
});

describe('colours', () => {
  it('accepts hex with and without a leading hash, normalising to #rrggbb', () => {
    expect(ok({ digit: 'AABBCC' }).design.digitColor).toBe('#aabbcc');
    expect(ok({ digit: '#AABBCC' }).design.digitColor).toBe('#aabbcc');
  });

  it('rejects 3-digit shorthand, which the compositor cannot parse', () => {
    expect(err({ until: UNTIL, digit: 'fff' })).toMatch(/digit/);
  });

  it('rejects a named colour', () => {
    expect(err({ until: UNTIL, digit: 'red' })).toMatch(/digit/);
  });

  it('accepts `transparent` for the board only', () => {
    expect(ok({ board: 'transparent' }).design.boardBackground).toBe('transparent');
    expect(err({ until: UNTIL, digit: 'transparent' })).toMatch(/digit/);
  });
});

describe('units', () => {
  it('accepts a comma-separated subset', () => {
    expect(ok({ units: 'minutes,seconds' }).design.units).toEqual(['minutes', 'seconds']);
  });

  it('normalises order — a countdown reading SEC:DAYS would be a bug', () => {
    expect(ok({ units: 'seconds,days' }).design.units).toEqual(['days', 'seconds']);
  });

  it('tolerates whitespace and case', () => {
    expect(ok({ units: ' Days , SECONDS ' }).design.units).toEqual(['days', 'seconds']);
  });

  it('de-duplicates', () => {
    expect(ok({ units: 'seconds,seconds' }).design.units).toEqual(['seconds']);
  });

  it('rejects an unknown unit', () => {
    expect(err({ until: UNTIL, units: 'fortnights' })).toMatch(/units/);
  });

  it('rejects an empty list', () => {
    expect(err({ until: UNTIL, units: ',' })).toMatch(/units/);
  });

  it('accepts every documented unit name', () => {
    for (const unit of UNIT_NAMES) {
      expect(ok({ units: unit }).design.units).toEqual([unit]);
    }
  });
});

describe('clamping — these are DoS guards, not style preferences', () => {
  it('rejects a font size beyond the bounds rather than silently clamping', () => {
    // Silent clamping would let a caller believe they got what they asked for.
    expect(err({ until: UNTIL, size: String(MAX_FONT_SIZE + 1) })).toMatch(/size/);
    expect(err({ until: UNTIL, size: String(MIN_FONT_SIZE - 1) })).toMatch(/size/);
  });

  it('accepts the exact bounds', () => {
    expect(ok({ size: String(MIN_FONT_SIZE) }).design.fontSize).toBe(MIN_FONT_SIZE);
    expect(ok({ size: String(MAX_FONT_SIZE) }).design.fontSize).toBe(MAX_FONT_SIZE);
  });

  it('rejects a non-integer or absurd size', () => {
    expect(err({ until: UNTIL, size: '1e9' })).toMatch(/size/);
    expect(err({ until: UNTIL, size: 'huge' })).toMatch(/size/);
  });

  it('bounds border width', () => {
    expect(err({ until: UNTIL, borderWidth: '999' })).toMatch(/borderWidth/);
    expect(err({ until: UNTIL, borderWidth: '-1' })).toMatch(/borderWidth/);
  });
});

describe('enums', () => {
  it('accepts every documented divider style', () => {
    for (const divider of DIVIDER_STYLES) {
      expect(ok({ divider }).design.dividerStyle).toBe(divider);
    }
  });

  it('accepts every documented shape', () => {
    for (const shape of SHAPES) {
      expect(ok({ shape }).design.shape).toBe(shape);
    }
  });

  it('rejects anything else', () => {
    expect(err({ until: UNTIL, divider: 'dashes' })).toMatch(/divider/);
    expect(err({ until: UNTIL, shape: 'blob' })).toMatch(/shape/);
  });
});

describe('labels', () => {
  it('accepts the usual truthy and falsy spellings', () => {
    for (const truthy of ['1', 'true', 'yes']) {
      expect(ok({ labels: truthy }).design.showLabels).toBe(true);
    }
    for (const falsy of ['0', 'false', 'no']) {
      expect(ok({ labels: falsy }).design.showLabels).toBe(false);
    }
  });
});

describe('custom captions', () => {
  /**
   * The one thing here that can silently drift: a unit added to `UNIT_NAMES`
   * with no matching query parameter would be un-customisable, and nothing else
   * would fail. Derived from `UNIT_NAMES` so the check widens on its own.
   */
  it('exposes a parameter for every unit', () => {
    expect(UNIT_NAMES.length).toBeGreaterThan(0); // non-vacuity
    for (const unit of UNIT_NAMES) {
      expect(Object.keys(countdownParamsSchema.shape)).toContain(unitLabelParam(unit));
    }
  });

  it('carries every unit through to the design', () => {
    // Guards the other half: a parameter declared but never read would parse
    // fine and render the default caption.
    const query = Object.fromEntries(UNIT_NAMES.map((u, i) => [unitLabelParam(u), `L${i}`]));
    const { design } = ok(query);
    for (const [i, unit] of UNIT_NAMES.entries()) {
      expect(resolveUnitLabel(unit, design.unitLabels)).toBe(`L${i}`);
    }
  });

  it('leaves units it was not given on their defaults', () => {
    const { design } = ok({ labelDays: 'JOURS' });
    expect(resolveUnitLabel('days', design.unitLabels)).toBe('JOURS');
    expect(resolveUnitLabel('hours', design.unitLabels)).toBe(UNIT_LABELS.hours);
  });

  it('trims surrounding whitespace', () => {
    expect(resolveUnitLabel('days', ok({ labelDays: '  JOURS  ' }).design.unitLabels)).toBe('JOURS');
  });

  it('treats a blank caption as unset, matching the library behaviour', () => {
    expect(ok({ labelDays: '   ' }).design).toEqual(DEFAULT_DESIGN);
    expect(ok({ labelDays: '' }).design).toEqual(DEFAULT_DESIGN);
  });

  it('rejects a caption past the length cap rather than truncating it', () => {
    expect(ok({ labelDays: 'W'.repeat(MAX_LABEL_LENGTH) }).design.unitLabels?.days).toHaveLength(
      MAX_LABEL_LENGTH,
    );
    expect(err({ until: UNTIL, labelDays: 'W'.repeat(MAX_LABEL_LENGTH + 1) })).toMatch(/labelDays/);
  });

  it('rejects control characters, which XML cannot represent', () => {
    // Otherwise the rasteriser gets an unparseable document and this surfaces
    // as a 500 instead of an actionable 400.
    const NUL = String.fromCharCode(0);
    const UNIT_SEP = String.fromCharCode(0x1f);
    expect(err({ until: UNTIL, labelDays: `A${NUL}B` })).toMatch(/labelDays/);
    expect(err({ until: UNTIL, labelDays: `A${UNIT_SEP}B` })).toMatch(/labelDays/);
  });

  it('accepts accented and non-Latin captions', () => {
    expect(resolveUnitLabel('days', ok({ labelDays: 'días' }).design.unitLabels)).toBe('días');
    expect(resolveUnitLabel('hours', ok({ labelHours: 'ЧАС' }).design.unitLabels)).toBe('ЧАС');
  });

  it('accepts markup characters — escaping is the renderer\'s job, not a rejection', () => {
    expect(resolveUnitLabel('days', ok({ labelDays: '<b>&"' }).design.unitLabels)).toBe('<b>&"');
  });
});

describe('error messages', () => {
  it('names the offending field so a 400 is actionable', () => {
    expect(err({ until: UNTIL, size: 'abc' })).toMatch(/^size: /);
  });

  it('ignores unknown parameters rather than failing', () => {
    // CDNs and email clients append tracking params; failing on them would
    // break images in the wild.
    expect(ok({ utm_source: 'newsletter', fbclid: 'xyz' }).design).toEqual(DEFAULT_DESIGN);
  });
});
