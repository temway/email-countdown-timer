import { describe, expect, it } from 'vitest';
import { MAX_LABEL_LENGTH, MAX_OUTPUT_WIDTH, unitLabelParam } from '../params.js';
import { layoutBoard } from '../raster/layout.js';
import {
  DEFAULT_DESIGN,
  resolveUnitLabel,
  UNIT_LABELS,
  UNIT_NAMES,
  type CountdownDesign,
  type DividerStyle,
} from '../raster/options.js';
import { renderBuilderPage } from './builder.js';

function design(overrides: Partial<CountdownDesign> = {}): CountdownDesign {
  return { ...DEFAULT_DESIGN, ...overrides };
}

describe('the inline scripts are valid JavaScript', () => {
  /**
   * The page is one big template literal, so its scripts are never parsed by
   * anything during a build — a stray backtick or an accidental `${}` produces
   * either a TypeScript error (if you are lucky) or a page that renders and
   * quietly does nothing (if you are not). `new Function` parses without
   * evaluating, which is exactly the check that was missing.
   *
   * Not hypothetical: a backtick inside a code comment in the script block
   * terminated the template literal during this feature's development.
   */
  it('parses every script block', () => {
    const html = renderBuilderPage(false);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

    // Non-vacuity: the theme bootstrap, the width predictor and the builder logic.
    expect(scripts).toHaveLength(3);
    for (const [i, source] of scripts.entries()) {
      expect(source.trim().length, `script ${i} is empty`).toBeGreaterThan(50);
      expect(() => new Function(source), `script ${i} does not parse`).not.toThrow();
    }
  });

  it('leaves no unresolved template placeholders', () => {
    // A `${...}` that survives into the output means an interpolation was
    // escaped by accident and the page is showing source code.
    expect(renderBuilderPage(false)).not.toMatch(/\$\{/);
  });
});

describe('the snippet carries a CSS width, not a pixel width', () => {
  const html = renderBuilderPage(false);

  it('offers the Retina control that drives `scale`', () => {
    expect(html).toContain('id="retina"');
    // One derivation feeds both the URL parameter and the width prediction.
    expect(html).toContain('const scale = retina.checked ? 2 : 1');
    expect(html).toContain("params.set('scale', String(scale))");
  });

  it('divides the loaded pixel width by the scale', () => {
    // The whole point of rendering at 2x: an <img> declaring the PIXEL width
    // (or no width) draws double size in every client. If this ever regresses
    // the images still render, they are just twice as big — which is exactly
    // the kind of break nobody notices until it is in a sent campaign.
    expect(html).toContain('preview.naturalWidth / scale');
  });

  it('tells the reader why a too-wide board fails to preview', () => {
    expect(html).toContain('id="tooWide"');
    expect(html).toContain(`${MAX_OUTPUT_WIDTH}px`);
  });
});

describe('the caption inputs match what the server accepts', () => {
  const html = renderBuilderPage(false);

  it('offers an input per unit, defaulted to that unit\'s caption', () => {
    expect(UNIT_NAMES.length).toBeGreaterThan(0); // non-vacuity
    for (const unit of UNIT_NAMES) {
      expect(html, unit).toContain(`name="${unitLabelParam(unit)}"`);
      expect(html, unit).toContain(`placeholder="${UNIT_LABELS[unit]}"`);
    }
  });

  it('enforces the server-side cap in the browser too', () => {
    // Not security — the server still validates. It stops the builder from
    // handing someone a URL that 400s.
    const caps = [...html.matchAll(/maxlength="(\d+)"/g)].map((m) => Number(m[1]));
    expect(caps).toHaveLength(UNIT_NAMES.length);
    for (const cap of caps) expect(cap).toBe(MAX_LABEL_LENGTH);
  });
});

describe('the footer carries attribution to Temway', () => {
  // Rendered without an origin on purpose: attribution is a credit to the
  // builder's authors, so it belongs on every self-hosted instance too, not
  // just the public one. The LICENSE already credits Temway the same way.
  const html = renderBuilderPage(false);

  it('links to temway.com with brand anchor text', () => {
    expect(html).toContain('<a href="https://temway.com">Temway</a>');
  });

  it('leaves the link followed', () => {
    // The whole point of the attribution is a crawlable followed link; a
    // rel="nofollow"/"sponsored" slipped in later would silently void it.
    const link = html.match(/<a href="https:\/\/temway\.com"[^>]*>/);
    expect(link).not.toBeNull();
    expect(link![0]).not.toMatch(/rel="/);
  });
});

describe('the shipped width predictor is the real arithmetic', () => {
  /**
   * The page predicts board width with boardCssWidth's SOURCE, embedded via
   * toString() at render time. board-width.test.ts proves the TypeScript
   * function matches layoutBoard; this proves the bytes in the PAGE match it —
   * the only copy a visitor's browser runs. If the embedding breaks (a rename,
   * a bundler appearing, the function growing an import), the browser would
   * silently fall back to 1970s behavior: request-then-400, the exact bug this
   * replaces. So the bytes are evaluated here and re-run against layoutBoard.
   */
  it('ships a callable boardCssWidth that agrees with layoutBoard', () => {
    const html = renderBuilderPage(false);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const source = scripts.find((s) => s.includes('function boardCssWidth'));
    expect(source, 'no script block defines boardCssWidth').toBeDefined();

    // The conservative-syntax rule for the embedded source, asserted where it
    // is enforced: a backtick or a dollar-brace in these bytes would break the
    // page's own no-placeholder test or a future inlining of the source.
    expect(source!).not.toMatch(/`/);
    expect(source!).not.toMatch(/\$\{/);

    const shipped = new Function(source! + '\nreturn boardCssWidth;')() as typeof import('./board-width.js')['boardCssWidth'];
    expect(typeof shipped).toBe('function');

    // A representative matrix, not the full one (that lives in board-width.test.ts
    // against the TypeScript original): the boundary sizes and the caption shapes.
    for (const fontSize of [12, 37, 48, 79, 80, 160]) {
      for (const dividerStyle of ['colon', 'dot', 'space'] as DividerStyle[]) {
        for (const borderWidth of [0, 24]) {
          for (const unitLabels of [
            {},
            { days: 'JOURS' },
            Object.fromEntries(UNIT_NAMES.map((u) => [u, 'W'.repeat(MAX_LABEL_LENGTH)])),
          ]) {
            const d = design({ fontSize, dividerStyle, borderWidth, unitLabels });
            const texts = d.units.map((u) => resolveUnitLabel(u, d.unitLabels));
            expect(
              shipped(fontSize, d.units.length, texts, dividerStyle, borderWidth),
              `shipped bytes, fontSize=${fontSize}`,
            ).toBe(layoutBoard(d).width);
          }
        }
      }
    }
  });
});

describe('the builder predicts instead of shipping doomed URLs', () => {
  const html = renderBuilderPage(false);

  it('carries a second notice for failures that are not about width', () => {
    // The original bug: one catch-all error handler labelled EVERY failed load
    // — a missing until, a dead network — as a width problem. A dedicated
    // element is the load-bearing fix; the width notice stays as its own case.
    expect(html).toContain('id="previewError"');
    expect(html).toContain('aria-live="polite"');
  });

  it('never blames width without exact numbers and a way out', () => {
    // The too-wide copy must name the largest fitting size, because "reduce
    // the digit size" made the user guess — the input allows 160 while four
    // units at 2x top out at 79.
    expect(html).toContain('Largest digit size that fits');
  });

  it('shows the ceiling where the size is typed, not only under the preview', () => {
    // On a phone the notice under the preview is out of view while the form is
    // being edited; the persistent per-field hint is the in-context channel.
    expect(html).toContain('id="sizeMax"');
    expect(html).toContain('sizeInput.max');
  });

  it('keeps a load-time default end date for browsers that drop it', () => {
    // Mobile WebKit can silently discard the value set on a datetime-local
    // input, which omitted until from the first URL and 400'd — the reported
    // mobile bug. The captured default fills the gap until the user edits.
    expect(html).toContain('defaultUntil');
  });

  it('blocks known-bad forms with targeted messages instead of a 400', () => {
    expect(html).toContain('Pick an end date');
    expect(html).toContain('Tick at least one unit');
  });

  it('asks the server what actually went wrong before guessing', () => {
    // On an unpredicted load failure the page fetches the URL and shows the
    // server's own message; only a real network failure stays generic.
    expect(html).toContain('fetch(requestedPath)');
  });
});
