/**
 * Library entry point, for embedding the renderer instead of running the server.
 *
 * Two levels are exposed on purpose:
 *
 *   - `renderCountdown(design, endsAt, now)` — the batteries-included path.
 *     Generates rasters, renders, and caches.
 *   - `generateArtifacts` + `renderCountdownGif` — the seam. Bring your own
 *     rasters (from a design tool, a headless browser, anywhere) and use the
 *     compositor directly. The compositor takes decoded RGBA and bounding boxes
 *     and knows nothing about where they came from.
 */

export { createApp } from './app.js';
export { loadConfig, type Config } from './config.js';
export {
  MAX_LABEL_LENGTH,
  countdownParamsSchema,
  parseCountdownParams,
  unitLabelParam,
  type ParsedCountdown,
  type ParseResult,
} from './params.js';
export { generateArtifacts, type CountdownArtifacts } from './raster/index.js';
export {
  estimateLabelWidth,
  layoutBoard,
  layoutDigitSheet,
  type BoardLayout,
  type DigitSheetLayout,
} from './raster/layout.js';
export {
  DEFAULT_DESIGN,
  DIVIDER_STYLES,
  SHAPES,
  UNIT_LABELS,
  UNIT_NAMES,
  resolveUnitLabel,
  type CountdownDesign,
  type DividerStyle,
  type Shape,
  type UnitLabelOverrides,
  type UnitName,
} from './raster/options.js';
export { getFontFamily, getFontPath, resetFont, setFont } from './raster/fonts.js';
export {
  THEMES,
  THEME_NAMES,
  findTheme,
  themeDesign,
  themeQuerySeed,
  type Theme,
  type ThemeStyle,
} from './raster/themes.js';
export {
  renderCountdownGif,
  type BoundingBox,
  type CountdownColors,
  type RasterImage,
  type RenderedArtifacts,
} from './render/compositor.js';
export {
  BUCKET_WIDTH_MS,
  MAX_DISPLAYABLE_MS,
  clearCaches,
  designKey,
  renderCountdown,
  type CountdownResult,
} from './service.js';
export { canonicalize, sign, verify } from './signing.js';
