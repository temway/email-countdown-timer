/**
 * Query-string → `CountdownDesign` + end date.
 *
 * The URL is the entire state of a timer, so this module is also the trust
 * boundary. Every numeric field is clamped rather than merely validated: font
 * size drives the raster area (and therefore CPU and memory) quadratically, so
 * an unbounded `size` is a denial-of-service vector on any public instance, not
 * just a rendering oddity.
 *
 * Colours accept `rrggbb` or `#rrggbb` and are normalised to the `#rrggbb` form
 * the compositor's palette merge expects. Three-character shorthand is rejected
 * — the compositor's `parseHex` requires six.
 */

import { z } from 'zod';
import { layoutBoard } from './raster/layout.js';
import {
  DEFAULT_DESIGN,
  DIVIDER_STYLES,
  SHAPES,
  UNIT_NAMES,
  type CountdownDesign,
  type Scale,
  type UnitLabelOverrides,
  type UnitName,
} from './raster/options.js';

/** Font size bounds. The upper bound caps a single render's raster area. */
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 160;

/**
 * Widest image this service will emit, in DEVICE pixels.
 *
 * An email body is ~600px wide, and at the default `scale=2` that is 1200
 * device px — past which a bigger render buys a recipient nothing and costs
 * everyone else CPU. It is the binding size constraint, not {@link MAX_FONT_SIZE}:
 * the board's width depends on the unit count and the caption lengths as well
 * as the font size, so no bound on `size` alone can express it. `MAX_FONT_SIZE`
 * survives as a cheap gate that rejects the absurd before the layout runs.
 */
export const MAX_OUTPUT_WIDTH = 1200;

/** Border thickness bounds. Exported for the builder, which mirrors the bound client-side. */
export const MAX_BORDER_WIDTH = 24;

/**
 * Longest custom unit caption, in characters.
 *
 * A DoS guard like the font-size bound, not a style rule: a caption wider than
 * its slot widens the board, and the board width multiplies through ~31 GIF
 * frames. Twelve characters clears the longest words anyone needs here
 * (`SEKUNDEN`, `SEGUNDOS`, `MINUTOS`) while keeping the worst-case raster
 * within a small multiple of the no-labels worst case.
 */
export const MAX_LABEL_LENGTH = 12;

/** Query parameter carrying a unit's caption override: `days` → `labelDays`. */
export function unitLabelParam(unit: UnitName): string {
  return `label${unit.charAt(0).toUpperCase()}${unit.slice(1)}`;
}

const hexColor = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/, 'expected a 6-digit hex colour, e.g. 1a1a2e or #1a1a2e')
  .transform((v) => (v.startsWith('#') ? v.toLowerCase() : `#${v.toLowerCase()}`));

const boardBackground = z.union([z.literal('transparent'), hexColor]);

const boolish = z
  .enum(['0', '1', 'true', 'false', 'yes', 'no'])
  .transform((v) => v === '1' || v === 'true' || v === 'yes');

/**
 * Units as a comma-separated list. Order is normalised to `UNIT_NAMES` order —
 * a countdown reading `SEC:DAYS` would be a bug, not a feature.
 */
const units = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
  .pipe(z.array(z.enum(UNIT_NAMES)).min(1, 'at least one unit is required'))
  .transform((list) => UNIT_NAMES.filter((u) => list.includes(u)) as UnitName[]);

/**
 * `until` accepts anything `Date` parses, but ISO 8601 with an explicit offset
 * (`2026-12-25T00:00:00Z`) is the only form without ambiguity — a bare local
 * datetime would resolve against the *server's* timezone, which is not what the
 * author meant.
 */
const until = z
  .string()
  .transform((v, ctx) => {
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a parseable date' });
      return z.NEVER;
    }
    return ms;
  });

function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A custom unit caption.
 *
 * Control characters are rejected rather than stripped: XML cannot represent
 * most of them, so `?labelDays=%00` would otherwise reach the rasteriser as an
 * unparseable document and surface as a 500 instead of an actionable 400.
 */
const unitLabel = z
  .string()
  .trim()
  .max(MAX_LABEL_LENGTH, `must be at most ${MAX_LABEL_LENGTH} characters`)
  .refine((v) => !hasControlChar(v), 'must not contain control characters')
  .optional();

/**
 * Written out rather than derived from `UNIT_NAMES` so zod keeps inferring
 * exact field types. `params.test.ts` asserts every unit has a key here, which
 * is the part that would otherwise drift.
 */
const unitLabelShape = {
  labelDays: unitLabel,
  labelHours: unitLabel,
  labelMinutes: unitLabel,
  labelSeconds: unitLabel,
};

export const countdownParamsSchema = z.object({
  until,
  units: units.default(UNIT_NAMES.join(',')),
  labels: boolish.default('1'),
  ...unitLabelShape,
  digit: hexColor.default(DEFAULT_DESIGN.digitColor),
  board: boardBackground.default(DEFAULT_DESIGN.boardBackground),
  border: hexColor.default(DEFAULT_DESIGN.borderColor),
  borderWidth: z.coerce.number().int().min(0).max(MAX_BORDER_WIDTH).default(DEFAULT_DESIGN.borderWidth),
  divider: z.enum(DIVIDER_STYLES).default(DEFAULT_DESIGN.dividerStyle),
  shape: z.enum(SHAPES).default(DEFAULT_DESIGN.shape),
  size: z.coerce
    .number()
    .int()
    .min(MIN_FONT_SIZE)
    .max(MAX_FONT_SIZE)
    .default(DEFAULT_DESIGN.fontSize),
  // An enum rather than a bounded number, so `scale=1.5` and `scale=3` are
  // rejected by the same rule instead of one being coerced and the other not.
  scale: z
    .enum(['1', '2'])
    .transform((v) => Number(v) as Scale)
    .default(String(DEFAULT_DESIGN.scale) as '1' | '2'),
});

export interface ParsedCountdown {
  readonly design: CountdownDesign;
  readonly endsAt: number;
}

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedCountdown }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a raw query object. Returns a result rather than throwing so the route
 * can map failures to 400 without a try/catch.
 */
export function parseCountdownParams(query: Record<string, string | undefined>): ParseResult {
  // Strip undefined so zod's `.default()` applies instead of failing on an
  // explicit undefined.
  const input: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') input[key] = value;
  }

  const parsed = countdownParamsSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') ?? 'query';
    return { ok: false, error: `${path}: ${first?.message ?? 'invalid'}` };
  }

  const p = parsed.data;

  // Only units the caller actually named get an entry, so `resolveUnitLabel`
  // falls through to the default for the rest.
  const unitLabels: Partial<Record<UnitName, string>> = {};
  if (p.labelDays) unitLabels.days = p.labelDays;
  if (p.labelHours) unitLabels.hours = p.labelHours;
  if (p.labelMinutes) unitLabels.minutes = p.labelMinutes;
  if (p.labelSeconds) unitLabels.seconds = p.labelSeconds;

  const design: CountdownDesign = {
    units: p.units,
    showLabels: p.labels,
    unitLabels: unitLabels as UnitLabelOverrides,
    digitColor: p.digit,
    boardBackground: p.board,
    borderColor: p.border,
    borderWidth: p.borderWidth,
    dividerStyle: p.divider,
    shape: p.shape,
    fontSize: p.size,
    scale: p.scale,
  };

  // The real size guard, and the only one that can see the finished board. It
  // runs after zod because it needs the assembled design: font size, unit count
  // and caption lengths all feed the width. `layoutBoard` is pure arithmetic —
  // no rasteriser, no allocation worth counting — so running it to decide
  // whether to reject is cheaper than the render it prevents.
  const outputWidth = layoutBoard(design).width * design.scale;
  if (outputWidth > MAX_OUTPUT_WIDTH) {
    return {
      ok: false,
      error:
        `size: the board renders ${outputWidth}px wide at scale=${design.scale}, over the ${MAX_OUTPUT_WIDTH}px maximum` +
        ' — reduce size, drop a unit, shorten a caption, or use scale=1',
    };
  }

  return { ok: true, value: { endsAt: p.until, design } };
}
