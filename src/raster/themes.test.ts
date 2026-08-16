import { describe, expect, it } from 'vitest';
import { MAX_OUTPUT_WIDTH, parseCountdownParams } from '../params.js';
import { layoutBoard } from './layout.js';
import { DEFAULT_DESIGN } from './options.js';
import { THEMES, THEME_NAMES, findTheme, themeDesign, themeQuerySeed } from './themes.js';

const UNTIL = '2026-12-25T00:00:00.000Z';

describe('the theme registry', () => {
  it('has unique, lowercase, URL-safe names', () => {
    expect(new Set(THEME_NAMES).size).toBe(THEMES.length); // non-vacuous: no duplicates
    for (const theme of THEMES) {
      expect(theme.name, theme.label).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('finds themes case-insensitively and rejects nothing the registry lacks', () => {
    expect(findTheme('Ocean')?.name).toBe('ocean');
    expect(findTheme(' does-not-exist ')).toBeUndefined();
  });

  it('keeps seed colours in the normalised form the schema expects', () => {
    // A seed like `#FFD166` would round-trip through the hex transform fine,
    // but then `themeQuerySeed` and the registry literal would disagree with
    // what the design ends up carrying — the diff-based builder URLs would
    // emit a spurious override.
    for (const theme of THEMES) {
      for (const key of ['digitColor', 'labelColor', 'borderColor'] as const) {
        expect(theme.style[key], `${theme.name}.${key}`).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(theme.style.boardBackground, `${theme.name}.boardBackground`).toMatch(
        /^(#[0-9a-f]{6}|transparent)$/,
      );
    }
  });

  it('fits every theme inside MAX_OUTPUT_WIDTH at scale 2, worst-case content', () => {
    // Worst case is all four units with default captions — more units or
    // longer captions only widen the board. A theme that needs a smaller
    // `size` to fit is a registry bug the builder would surface as a
    // permanently-blocked preview.
    for (const theme of THEMES) {
      const width = layoutBoard(themeDesign(theme)).width * 2;
      expect(width, `${theme.name} renders ${width}px`).toBeLessThanOrEqual(MAX_OUTPUT_WIDTH);
    }
  });
});

describe('theme ↔ parser round trip', () => {
  /**
   * The load-bearing invariant of the theme layer: parsing `?theme=<name>`
   * must yield exactly the design the registry describes. If it does not, the
   * server's expansion, the builder's diff-based URLs, and the demos are
   * quietly describing three different looks.
   */
  it('parses every theme to its registry design', () => {
    for (const theme of THEMES) {
      const result = parseCountdownParams({ until: UNTIL, theme: theme.name });
      expect(result.ok, theme.name).toBe(true);
      if (!result.ok) continue;
      expect(result.value.design, theme.name).toEqual(themeDesign(theme));
    }
  });

  it('seeds as query strings that parse back to the same values', () => {
    for (const theme of THEMES) {
      const seed = themeQuerySeed(theme);
      const themed = parseCountdownParams({ until: UNTIL, theme: theme.name });
      const expanded = parseCountdownParams({ until: UNTIL, ...seed });
      expect(themed.ok && expanded.ok, theme.name).toBe(true);
      if (!themed.ok || !expanded.ok) continue;
      expect(themed.value.design, theme.name).toEqual(expanded.value.design);
    }
  });

  it('keeps the first four themes byte-compatible with the original demos', () => {
    // dark/amber/light/minimal mirror the pre-theme DEMOS exactly, captions on
    // the digit ink — regenerating those GIFs must be a no-op (checked by
    // `pnpm demos` + git). Here: the mirror itself, at the design level.
    expect(THEME_NAMES.slice(0, 4)).toEqual(['dark', 'amber', 'light', 'minimal']);
    for (const name of ['dark', 'amber', 'light', 'minimal']) {
      const theme = findTheme(name);
      expect(theme, name).toBeDefined();
      if (!theme) continue;
      expect(theme.style.labelColor, name).toBe(theme.style.digitColor);
    }
  });
});

describe('the dark theme is the default look', () => {
  // If `dark` ever drifts from DEFAULT_DESIGN, `?theme=dark` stops being a
  // byte-identical alias for the no-theme render and the byte-identity story
  // needs revisiting.
  it('mirrors the default style field for field', () => {
    expect(findTheme('dark')?.style).toEqual({
      digitColor: DEFAULT_DESIGN.digitColor,
      labelColor: DEFAULT_DESIGN.labelColor,
      boardBackground: DEFAULT_DESIGN.boardBackground,
      borderColor: DEFAULT_DESIGN.borderColor,
      borderWidth: DEFAULT_DESIGN.borderWidth,
      dividerStyle: DEFAULT_DESIGN.dividerStyle,
      shape: DEFAULT_DESIGN.shape,
      fontSize: DEFAULT_DESIGN.fontSize,
    });
  });
});
