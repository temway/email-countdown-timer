import type { DividerStyle } from '../raster/options.js';

/**
 * Board width in CSS px, computed WITHOUT rendering — the client-side twin of
 * the width arithmetic in layoutBoard (src/raster/layout.ts).
 *
 * The builder page embeds this function's SOURCE (Function.prototype.toString,
 * injected at template-render time) so the browser can predict a board's width
 * before asking the server for it: a configuration over the 1200-device-px
 * ceiling is a 400, and reacting to that after the fact is how the mobile
 * first-load bug shipped. Same arithmetic on both ends, one definition of it.
 *
 * For that embedding to work the function must stay SELF-CONTAINED and
 * SYNTAX-CONSERVATIVE, and this is a hard rule for edits below:
 *   - numeric literals, never the named ratios from layout.ts — toString()
 *     would emit an identifier that does not exist in the page;
 *   - no template literals, no backticks, no dollar-brace, no default
 *     parameters — the source is spliced into generated markup and asserted
 *     against by tests that grep for it;
 *   - text.length (UTF-16 units) like estimateLabelWidth, whose deliberate
 *     over-estimate this mirrors — a surrogate pair counts as two.
 *
 * CONTRACT: labelTexts must be [] when labels are off, never the live texts.
 * layoutBoard skips every caption term in that case (layout.ts:147-149), and
 * passing texts anyway would count letter-spacing and the 8px caption floor the
 * server does not — predicting too wide. board-width.test.ts pins the
 * equivalence at every legal font size.
 */
export function boardCssWidth(
  fontSize: number,
  unitCount: number,
  labelTexts: string[],
  dividerStyle: DividerStyle,
  borderWidth: number,
): number {
  // Digit advance (600/1000 em) — rounded, as digitAdvance does.
  const advance = Math.round(fontSize * 0.6);
  const slotW = advance * 2;

  // Caption metrics. The 8px floor is the same one layoutBoard applies.
  const labelFontSize = Math.max(8, Math.round(fontSize * 0.26));
  const labelLetterSpacing = labelTexts.length ? fontSize * 0.02 : 0;

  // How far each caption sticks out past its slot on one side, symmetric.
  const overhang = labelTexts.map((text) =>
    Math.max(0, Math.ceil((text.length * (labelFontSize * 0.6 + labelLetterSpacing) - slotW) / 2)),
  );

  // One uniform gap, sized for the tightest adjacent pair (slots stay even).
  const baseDividerW =
    dividerStyle === 'space' ? Math.round(fontSize * 0.3) : Math.round(fontSize * 0.55);
  const minLabelGap = Math.round(labelFontSize * 0.6);
  let dividerW = baseDividerW;
  for (let i = 1; i < overhang.length; i++) {
    dividerW = Math.max(dividerW, overhang[i - 1] + overhang[i] + minLabelGap);
  }

  const edgeOverhang = overhang.length ? Math.max(overhang[0], overhang[overhang.length - 1]) : 0;
  const padX = Math.max(
    Math.round(fontSize * 0.55),
    edgeOverhang + Math.round(fontSize * 0.15),
  );

  return borderWidth * 2 + padX * 2 + unitCount * slotW + Math.max(0, unitCount - 1) * dividerW;
}
