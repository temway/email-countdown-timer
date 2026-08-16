/**
 * Font loading for the rasteriser.
 *
 * Exactly one font is registered and system fonts are disabled, so rendering is
 * byte-identical on a laptop, in CI, and inside the Docker image. That
 * determinism is what makes golden-image tests meaningful — with system fonts
 * enabled, whichever font the host happened to have could silently win, and the
 * same URL would render differently on two machines.
 *
 * The guarantee is verified, not assumed: with `loadSystemFonts: false` and no
 * font source, resvg renders zero ink (see `fonts.test.ts`). So every glyph in
 * the output provably comes from the file below.
 *
 * The bundled face is Noto Sans Mono (SIL Open Font License 1.1 — see
 * `fonts/OFL.txt`). Monospace matters beyond taste: tabular digits keep every
 * glyph on the same advance, so the countdown does not jitter horizontally as
 * the numbers change. A proportional font would shift the whole row every time
 * a `1` replaced a `0`.
 *
 * We pass a font PATH rather than a buffer. resvg-js 2.6 accepts an
 * undocumented `fontBuffers` option that works at runtime but is absent from its
 * type definitions; `fontFiles` is the documented, typed, and equally
 * deterministic route.
 */

import { fileURLToPath } from 'node:url';

/** Family name declared inside the bundled TTF. */
export const DEFAULT_FONT_FAMILY = 'Noto Sans Mono';

const BUNDLED_FONT_PATH = fileURLToPath(new URL('../../fonts/NotoSansMono.ttf', import.meta.url));

let fontPath = BUNDLED_FONT_PATH;
let fontFamily = DEFAULT_FONT_FAMILY;

/** Absolute path to the font the rasteriser will use. */
export function getFontPath(): string {
  return fontPath;
}

export function getFontFamily(): string {
  return fontFamily;
}

/**
 * Render with your own font instead of the bundled one.
 *
 * Pass the family name exactly as declared inside the file. Anything
 * non-monospace will jitter as digits change — see the note above.
 */
export function setFont(path: string, family: string): void {
  fontPath = path;
  fontFamily = family;
}

/** Restore the bundled Noto Sans Mono. */
export function resetFont(): void {
  fontPath = BUNDLED_FONT_PATH;
  fontFamily = DEFAULT_FONT_FAMILY;
}
