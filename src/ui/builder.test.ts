import { describe, expect, it } from 'vitest';
import { MAX_LABEL_LENGTH, MAX_OUTPUT_WIDTH, unitLabelParam } from '../params.js';
import { UNIT_LABELS, UNIT_NAMES } from '../raster/options.js';
import { renderBuilderPage } from './builder.js';

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

    // Non-vacuity: the theme bootstrap and the builder logic.
    expect(scripts).toHaveLength(2);
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
    expect(html).toContain("params.set('scale', retina.checked ? '2' : '1')");
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
