/**
 * Named looks for a countdown board — the preset layer over `CountdownDesign`.
 *
 * A theme seeds STYLE values only. It never touches content (`units`,
 * `showLabels`, `unitLabels`, `scale`) or the end date: a theme says what the
 * board looks like, never what it counts or until when. The split is what lets
 * `?theme=ocean&units=hours,minutes` mean "the ocean look, counting hours and
 * minutes" without the theme fighting the caller.
 *
 * The server stays stateless and the URL stays the timer: `theme` is resolved
 * to its seed values inside `parseCountdownParams` (see `src/params.ts`) before
 * validation, and any style parameter the caller named explicitly overrides the
 * seed. A themed URL therefore pins the theme's NAME, not its values — editing
 * the registry re-renders existing URLs. That is the accepted trade for URLs
 * short enough to paste.
 */

import type { BoardBackground, DividerStyle, Shape } from './options.js';
import { DEFAULT_DESIGN, type CountdownDesign } from './options.js';

/**
 * The style half of {@link CountdownDesign}, minus `scale` (a fidelity knob,
 * not a look). Themes are written as `ThemeStyle` so the compiler rejects a
 * theme that tries to seed content.
 */
export interface ThemeStyle {
  readonly digitColor: string;
  readonly labelColor: string;
  readonly boardBackground: BoardBackground;
  readonly borderColor: string;
  readonly borderWidth: number;
  readonly dividerStyle: DividerStyle;
  readonly shape: Shape;
  readonly fontSize: number;
}

/** A named look: registry metadata plus the style seed. */
export interface Theme {
  /** URL identifier — lowercase, URL-safe, unique across the registry. */
  readonly name: string;
  /** Human name for the builder swatch. */
  readonly label: string;
  /** One line for the README table and the swatch's `title`/alt text. */
  readonly description: string;
  readonly style: ThemeStyle;
}

/**
 * The registry. `dark` mirrors `DEFAULT_DESIGN` exactly, so `?theme=dark`
 * renders byte-identical to no theme at all; `amber`/`light`/`minimal` mirror
 * the original demo designs (captions on the digit ink — they predate
 * `labelColor`), and the rest use it.
 *
 * Colour values are pre-normalised to lowercase `#rrggbb` (or `'transparent'`)
 * so a seed survives the schema's transforms unchanged and `themeQuerySeed`
 * round-trips: what the registry says is what the URL carries is what the
 * design gets.
 */
export const THEMES: readonly Theme[] = [
  {
    name: 'dark',
    label: 'Dark',
    description: 'White digits on deep navy — the default look',
    style: {
      digitColor: '#ffffff',
      labelColor: '#ffffff',
      boardBackground: '#1a1a2e',
      borderColor: '#1a1a2e',
      borderWidth: 0,
      dividerStyle: 'colon',
      shape: 'rounded',
      fontSize: 48,
    },
  },
  {
    name: 'amber',
    label: 'Amber',
    description: 'Warm amber digits on ocean navy',
    style: {
      digitColor: '#ffd166',
      labelColor: '#ffd166',
      boardBackground: '#0b2a4a',
      borderColor: '#1a1a2e',
      borderWidth: 0,
      dividerStyle: 'colon',
      shape: 'rounded',
      fontSize: 44,
    },
  },
  {
    name: 'light',
    label: 'Light',
    description: 'Near-black digits on a light card with a soft border',
    style: {
      digitColor: '#18181b',
      labelColor: '#18181b',
      boardBackground: '#f4f4f5',
      borderColor: '#d4d4d8',
      borderWidth: 2,
      dividerStyle: 'dot',
      shape: 'rounded',
      fontSize: 44,
    },
  },
  {
    name: 'minimal',
    label: 'Minimal',
    description: 'Bare rose digits, no board — sits on the email itself',
    style: {
      digitColor: '#e11d48',
      labelColor: '#e11d48',
      boardBackground: 'transparent',
      borderColor: '#e11d48',
      borderWidth: 0,
      dividerStyle: 'colon',
      shape: 'rounded',
      fontSize: 40,
    },
  },
  {
    name: 'ocean',
    label: 'Ocean',
    description: 'Ice-blue digits, misted captions, midnight-teal board',
    style: {
      digitColor: '#e0f2fe',
      labelColor: '#7dd3fc',
      boardBackground: '#082f49',
      borderColor: '#164e63',
      borderWidth: 1,
      dividerStyle: 'colon',
      shape: 'rounded',
      fontSize: 44,
    },
  },
  {
    name: 'forest',
    label: 'Forest',
    description: 'Mint digits, pine captions, deep-green board',
    style: {
      digitColor: '#86efac',
      labelColor: '#4ade80',
      boardBackground: '#052e16',
      borderColor: '#14532d',
      borderWidth: 0,
      dividerStyle: 'colon',
      shape: 'rounded',
      fontSize: 44,
    },
  },
  {
    name: 'rose',
    label: 'Rose',
    description: 'Crimson digits on blush, dotted dividers',
    style: {
      digitColor: '#e11d48',
      labelColor: '#9f1239',
      boardBackground: '#fff1f2',
      borderColor: '#fecdd3',
      borderWidth: 2,
      dividerStyle: 'dot',
      shape: 'rounded',
      fontSize: 44,
    },
  },
  {
    name: 'slate',
    label: 'Slate',
    description: 'Ink digits on a transparent board with a silver rule',
    style: {
      digitColor: '#0f172a',
      labelColor: '#64748b',
      boardBackground: 'transparent',
      borderColor: '#cbd5e1',
      borderWidth: 1,
      dividerStyle: 'colon',
      shape: 'rounded',
      fontSize: 40,
    },
  },
];

/** Registry names, in display order. */
export const THEME_NAMES: readonly string[] = THEMES.map((t) => t.name);

/** Look up a theme by its URL name. Case-insensitive on purpose. */
export function findTheme(name: string): Theme | undefined {
  const needle = name.trim().toLowerCase();
  return THEMES.find((t) => t.name === needle);
}

/**
 * `ThemeStyle` key → query parameter name. One table, used by the server's
 * seed injection, the builder's URL diffing, and the demos tool — the three
 * places that must agree on how a theme is spelled in a URL.
 */
export const THEME_STYLE_PARAMS: Record<keyof ThemeStyle, string> = {
  digitColor: 'digit',
  labelColor: 'label',
  boardBackground: 'board',
  borderColor: 'border',
  borderWidth: 'borderWidth',
  dividerStyle: 'divider',
  shape: 'shape',
  fontSize: 'size',
};

/**
 * The theme's seed as query-parameter strings — exactly what
 * `parseCountdownParams` injects for a `?theme=<name>` request, and what the
 * builder diffs a form against. Values are the registry literals, already in
 * the normalised form the schema expects.
 */
export function themeQuerySeed(theme: Theme): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const [key, param] of Object.entries(THEME_STYLE_PARAMS)) {
    seed[param] = String(theme.style[key as keyof ThemeStyle]);
  }
  return seed;
}

/** A full design for a theme's style with default content — demos and previews. */
export function themeDesign(theme: Theme): CountdownDesign {
  return { ...DEFAULT_DESIGN, ...theme.style };
}
