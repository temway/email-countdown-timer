/**
 * The design surface of a countdown board.
 *
 * These are the knobs a caller can turn. Everything here is serialisable and
 * maps 1:1 onto query-string parameters (see `src/params.ts`) — the server is
 * stateless, so the URL *is* the timer.
 */

/** Time units, in the order they are laid out left-to-right. */
export const UNIT_NAMES = ['days', 'hours', 'minutes', 'seconds'] as const;
export type UnitName = (typeof UNIT_NAMES)[number];

/** Short labels drawn under each unit when `showLabels` is on. */
export const UNIT_LABELS: Record<UnitName, string> = {
  days: 'DAYS',
  hours: 'HRS',
  minutes: 'MIN',
  seconds: 'SEC',
};

/** Per-unit caption overrides. Any unit left out keeps its {@link UNIT_LABELS} default. */
export type UnitLabelOverrides = Readonly<Partial<Record<UnitName, string>>>;

/**
 * The caption to draw under `unit`.
 *
 * A blank or whitespace-only override means "use the default", not "draw
 * nothing". That rule exists because `parseCountdownParams` strips empty query
 * values before validation, so `?labelDays=` could not mean anything else at
 * the URL layer — and one rule that holds at both entry points beats two that
 * disagree. Hide captions with `showLabels: false`.
 */
export function resolveUnitLabel(unit: UnitName, overrides?: UnitLabelOverrides): string {
  const custom = overrides?.[unit]?.trim();
  return custom ? custom : UNIT_LABELS[unit];
}

/** Separator drawn in the gap between two unit slots. */
export const DIVIDER_STYLES = ['colon', 'dot', 'space'] as const;
export type DividerStyle = (typeof DIVIDER_STYLES)[number];

/** Board outline shape. */
export const SHAPES = ['rectangle', 'rounded'] as const;
export type Shape = (typeof SHAPES)[number];

/**
 * `'transparent'` is a first-class board background, not an edge case: the
 * compositor keys its GIF transparency flag off whether the board raster
 * contains any fully-transparent pixels (`boardHasTransparency`), so a
 * transparent board lets the recipient's email background show through.
 */
export type BoardBackground = string | 'transparent';

export interface CountdownDesign {
  /** Which units to show, in `UNIT_NAMES` order. At least one. */
  readonly units: ReadonlyArray<UnitName>;
  /** Draw short unit labels (DAYS/HRS/MIN/SEC) beneath the digits. */
  readonly showLabels: boolean;
  /**
   * Replace one or more of those captions — `{ days: 'JOURS' }`, or a full set
   * for another language. Optional so a hand-built design can omit it; read it
   * through {@link resolveUnitLabel}, never directly.
   *
   * A caption wider than its digit slot widens the BOARD (see `layout.ts`)
   * rather than clipping, so long words are safe but not free.
   */
  readonly unitLabels?: UnitLabelOverrides;
  /** Digit + divider + label ink colour, as `#rrggbb`. */
  readonly digitColor: string;
  /** Board fill — `#rrggbb` or the literal `'transparent'`. */
  readonly boardBackground: BoardBackground;
  /** Border colour, as `#rrggbb`. Ignored when `borderWidth` is 0. */
  readonly borderColor: string;
  /** Border thickness in px. 0 disables the border. */
  readonly borderWidth: number;
  readonly dividerStyle: DividerStyle;
  readonly shape: Shape;
  /** Digit font size in px. Drives every other dimension. */
  readonly fontSize: number;
}

export const DEFAULT_DESIGN: CountdownDesign = {
  units: UNIT_NAMES,
  showLabels: true,
  unitLabels: {},
  digitColor: '#ffffff',
  boardBackground: '#1a1a2e',
  borderColor: '#1a1a2e',
  borderWidth: 0,
  dividerStyle: 'colon',
  shape: 'rounded',
  fontSize: 48,
};

/**
 * The board colour the *palette* should use when the board is transparent.
 *
 * `renderCountdownGif` merges the three brand colours into the Plan9 palette
 * and cannot consume the literal `'transparent'`. The raster still renders with
 * no fill — this value only affects which palette entry gets replaced.
 */
export const TRANSPARENT_PALETTE_FALLBACK = '#1a1a2e';
