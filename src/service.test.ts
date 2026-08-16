import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DESIGN, type CountdownDesign } from './raster/options.js';
import {
  BUCKET_WIDTH_MS,
  MAX_DISPLAYABLE_MS,
  clearCaches,
  designKey,
  renderCountdown,
} from './service.js';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');

function design(overrides: Partial<CountdownDesign> = {}): CountdownDesign {
  return { ...DEFAULT_DESIGN, ...overrides };
}

beforeEach(() => {
  clearCaches();
});

describe('designKey', () => {
  it('is stable regardless of how the object was built', () => {
    const a: CountdownDesign = { ...DEFAULT_DESIGN };
    const b: CountdownDesign = {
      scale: DEFAULT_DESIGN.scale,
      fontSize: DEFAULT_DESIGN.fontSize,
      shape: DEFAULT_DESIGN.shape,
      dividerStyle: DEFAULT_DESIGN.dividerStyle,
      borderWidth: DEFAULT_DESIGN.borderWidth,
      borderColor: DEFAULT_DESIGN.borderColor,
      boardBackground: DEFAULT_DESIGN.boardBackground,
      digitColor: DEFAULT_DESIGN.digitColor,
      showLabels: DEFAULT_DESIGN.showLabels,
      units: DEFAULT_DESIGN.units,
    };
    expect(designKey(a)).toBe(designKey(b));
  });

  it('separates designs that differ in any single field', () => {
    const base = designKey(design());
    const variants: Partial<CountdownDesign>[] = [
      { units: ['seconds'] },
      { showLabels: false },
      { unitLabels: { days: 'JOURS' } },
      { digitColor: '#000000' },
      { boardBackground: 'transparent' },
      { borderColor: '#000000' },
      { borderWidth: 4 },
      { dividerStyle: 'dot' },
      { shape: 'rectangle' },
      { fontSize: 49 },
      { scale: 1 },
    ];
    // Non-vacuity: one entry per field of CountdownDesign.
    expect(variants).toHaveLength(Object.keys(DEFAULT_DESIGN).length);

    for (const overrides of variants) {
      expect(designKey(design(overrides)), JSON.stringify(overrides)).not.toBe(base);
    }
  });

  it('keys on the RESOLVED caption, so restating a default is not a new entry', () => {
    expect(designKey(design({ unitLabels: { days: 'DAYS' } }))).toBe(designKey(design()));
    expect(designKey(design({ unitLabels: { days: '  ' } }))).toBe(designKey(design()));
  });

  it('separates captions that would collide on the key delimiters', () => {
    // A caption is free text. Unencoded, `a|b` in one field could reproduce the
    // key of a different design — i.e. serve one caller's image to another.
    const a = designKey(design({ unitLabels: { days: 'A,B', hours: 'C' } }));
    const b = designKey(design({ unitLabels: { days: 'A', hours: 'B,C' } }));
    expect(a).not.toBe(b);

    const c = designKey(design({ unitLabels: { seconds: `X|${DEFAULT_DESIGN.digitColor}` } }));
    expect(c).not.toBe(designKey(design({ unitLabels: { seconds: 'X' } })));
  });
});

describe('captions are part of the cached image', () => {
  it('does not let one caption set serve another', () => {
    const endsAt = NOW + 3_600_000;
    const a = renderCountdown(design({ unitLabels: { days: 'JOURS' } }), endsAt, NOW);
    const b = renderCountdown(design({ unitLabels: { days: 'TAGE' } }), endsAt, NOW);
    expect(Buffer.from(a.gif)).not.toEqual(Buffer.from(b.gif));
  });
});

describe('rendering', () => {
  it('renders a GIF and a PNG', () => {
    const result = renderCountdown(design(), NOW + 86_400_000, NOW);
    expect(Buffer.from(result.gif.slice(0, 6)).toString('ascii')).toBe('GIF89a');
    expect(Array.from(result.png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(result.expired).toBe(false);
  });

  it('flags an elapsed timer as expired', () => {
    const result = renderCountdown(design(), NOW - 1000, NOW);
    expect(result.expired).toBe(true);
    expect(result.gif.length).toBeGreaterThan(0);
  });

  it('treats the exact end instant as expired', () => {
    expect(renderCountdown(design(), NOW, NOW).expired).toBe(true);
  });
});

describe('bucket caching', () => {
  /**
   * Buckets are keyed on time REMAINING, not on the wall clock, so advancing
   * `now` walks backwards through buckets. To stay inside one, the starting
   * remaining time must sit above the bucket floor by more than the step —
   * starting exactly on a boundary drops to the previous bucket on any advance.
   */
  it('serves the same bytes for two clock times inside one bucket', () => {
    const endsAt = NOW + 3_600_000 + BUCKET_WIDTH_MS / 2; // mid-bucket
    const a = renderCountdown(design(), endsAt, NOW);
    const b = renderCountdown(design(), endsAt, NOW + BUCKET_WIDTH_MS / 4);
    // Identity, not equality — a cache hit returns the very same buffer.
    expect(a.gif).toBe(b.gif);
  });

  it('re-renders once the bucket rolls over', () => {
    const endsAt = NOW + 3_600_000;
    const a = renderCountdown(design(), endsAt, NOW);
    const b = renderCountdown(design(), endsAt, NOW + BUCKET_WIDTH_MS);
    expect(a.gif).not.toBe(b.gif);
  });

  it('does not let one design serve another', () => {
    const endsAt = NOW + 3_600_000;
    const a = renderCountdown(design({ digitColor: '#ffffff' }), endsAt, NOW);
    const b = renderCountdown(design({ digitColor: '#ff0000' }), endsAt, NOW);
    expect(Buffer.from(a.gif)).not.toEqual(Buffer.from(b.gif));
  });

  it('collapses every expired request onto one entry', () => {
    // An expired timer is frozen forever; minting a bucket per request would
    // grow the cache without bound for a timer that never changes again.
    const a = renderCountdown(design(), NOW - 10_000, NOW);
    const b = renderCountdown(design(), NOW - 999_999, NOW);
    expect(a.gif).toBe(b.gif);
  });
});

describe('the 99-day ceiling', () => {
  /**
   * Regression: each unit has two digit slots and the compositor reduces every
   * digit with `% 10`, so 130 days used to render as "30" — a wrong number
   * shown to a recipient, not a rounding artefact. Caught by pointing a live
   * server at a date 130 days out.
   */
  it('renders the same frame for any duration past the ceiling', () => {
    const a = renderCountdown(design(), NOW + MAX_DISPLAYABLE_MS + 86_400_000, NOW);
    const b = renderCountdown(design(), NOW + MAX_DISPLAYABLE_MS + 900 * 86_400_000, NOW);
    // Wraparound would make a 100-day and a 1000-day timer differ.
    expect(a.gif).toBe(b.gif);
    expect(a.clamped).toBe(true);
  });

  it('renders 130 days identically to the ceiling, not to 30 days', () => {
    const oneHundredThirtyDays = renderCountdown(design(), NOW + 130 * 86_400_000, NOW);
    const atCeiling = renderCountdown(design(), NOW + MAX_DISPLAYABLE_MS, NOW);
    const thirtyDays = renderCountdown(design(), NOW + 30 * 86_400_000, NOW);

    expect(Buffer.from(oneHundredThirtyDays.gif)).toEqual(Buffer.from(atCeiling.gif));
    expect(Buffer.from(oneHundredThirtyDays.gif)).not.toEqual(Buffer.from(thirtyDays.gif));
  });

  it('leaves durations under the ceiling untouched', () => {
    const result = renderCountdown(design(), NOW + 98 * 86_400_000, NOW);
    expect(result.clamped).toBe(false);
  });

  it('does not treat a clamped timer as expired', () => {
    const result = renderCountdown(design(), NOW + 500 * 86_400_000, NOW);
    expect(result.expired).toBe(false);
    expect(result.clamped).toBe(true);
  });
});

describe('secondsToNextBucket drives CDN cache lifetime', () => {
  it('never returns zero, which would defeat caching entirely', () => {
    for (let offset = 0; offset < BUCKET_WIDTH_MS * 3; offset += 137) {
      const result = renderCountdown(design(), NOW + 3_600_000 + offset, NOW);
      expect(result.secondsToNextBucket).toBeGreaterThanOrEqual(1);
    }
  });

  it('never exceeds the bucket width for a live timer', () => {
    for (let offset = 0; offset < BUCKET_WIDTH_MS * 3; offset += 137) {
      const result = renderCountdown(design(), NOW + 3_600_000 + offset, NOW);
      expect(result.secondsToNextBucket).toBeLessThanOrEqual(BUCKET_WIDTH_MS / 1000);
    }
  });

  it('uses a long lifetime for an expired timer', () => {
    expect(renderCountdown(design(), NOW - 1, NOW).secondsToNextBucket).toBe(300);
  });
});
