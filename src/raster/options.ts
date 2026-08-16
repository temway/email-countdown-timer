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
 * Device pixels per CSS pixel.
 *
 * Restricted to integers, and to these two in particular. The layout is always
 * in CSS px and the compositor's bounding boxes are multiplied through by this
 * factor, which preserves the `floor(slot.width / 2) === cell.width` invariant
 * (see `layout.ts`) exactly — a slot is `2 * advance` and a cell is `advance`,
 * so scaling both by an integer keeps the relation. A fractional factor would
 * round the two independently and drift the sprites off their half-slots.
 */
export const SCALES = [1, 2] as const;
export type Scale = (typeof SCALES)[number];

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
  /** Digit + divider ink colour, as `#rrggbb`. */
  readonly digitColor: string;
  /**
   * Unit-caption ink colour, as `#rrggbb`. Digits and dividers keep
   * {@link CountdownDesign.digitColor}.
   *
   * Resolved rather than optional: the query layer falls back to the digit
   * colour once (`?label` absent ⇒ `labelColor === digitColor`), so no consumer
   * downstream of the design ever re-derives it.
   */
  readonly labelColor: string;
  /** Board fill — `#rrggbb` or the literal `'transparent'`. */
  readonly boardBackground: BoardBackground;
  /** Border colour, as `#rrggbb`. Ignored when `borderWidth` is 0. */
  readonly borderColor: string;
  /** Border thickness in px. 0 disables the border. */
  readonly borderWidth: number;
  readonly dividerStyle: DividerStyle;
  readonly shape: Shape;
  /** Digit font size in CSS px. Drives every other dimension. */
  readonly fontSize: number;
  /**
   * Device pixels per CSS px. `2` rasterises at double resolution so the image
   * stays sharp on a Retina display, which is what most mail gets read on.
   *
   * This does NOT change the layout: every number in `layout.ts` stays in CSS
   * px and only the rasteriser and the bounding boxes are scaled. So the width
   * an `<img>` tag should declare is always `layoutBoard(design).width`, and
   * the file is `scale` times wider than that.
   */
  readonly scale: Scale;
}

export const DEFAULT_DESIGN: CountdownDesign = {
  units: UNIT_NAMES,
  showLabels: true,
  unitLabels: {},
  digitColor: '#ffffff',
  labelColor: '#ffffff',
  boardBackground: '#1a1a2e',
  borderColor: '#1a1a2e',
  borderWidth: 0,
  dividerStyle: 'colon',
  shape: 'rounded',
  fontSize: 48,
  scale: 2,
};

/**
 * The board colour the *palette* should use when the board is transparent.
 *
 * `renderCountdownGif` merges the three brand colours into the Plan9 palette
 * and cannot consume the literal `'transparent'`. The raster still renders with
 * no fill — this value only affects which palette entry gets replaced.
 */
export const TRANSPARENT_PALETTE_FALLBACK = '#1a1a2e';
