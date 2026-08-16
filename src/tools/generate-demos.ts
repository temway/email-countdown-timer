/**
 * Regenerates the demo GIFs in `assets/` that the README shows.
 *
 *     pnpm demos          # write assets/*.gif
 *     pnpm demos --check  # verify they are up to date, write nothing
 *
 * These four files used to be produced by hand, which meant the designs behind
 * them existed only inside the GIFs — recovering them to re-render at 2x took
 * decoding the palettes and template-matching the digits. This script exists so
 * that never has to happen again: the designs live here, in the same types the
 * server uses, so `pnpm typecheck` breaks if `CountdownDesign` changes under
 * them.
 *
 * Rendering goes through `renderCountdown`, the exact path `/c.gif` takes, so a
 * demo cannot drift from what the service actually emits. It is deterministic —
 * `now = 0` and a fixed remaining time — so re-running with no source change
 * reproduces the bytes exactly, and `--check` is meaningful.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { layoutBoard } from '../raster/layout.js';
import { DEFAULT_DESIGN, type CountdownDesign } from '../raster/options.js';
import { renderCountdown } from '../service.js';

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');

/**
 * The moment every demo freezes at: `12d 05:42:59`.
 *
 * Fixed rather than derived from the clock so the output is reproducible, and
 * chosen so no unit reads zero — a demo showing `00` for days looks like a bug
 * in the renderer rather than a countdown with 12 days left.
 */
export const REMAINING_MS = 12 * 86_400_000 + 5 * 3_600_000 + 42 * 60_000 + 59_000;

export interface Demo {
  /** Base name under `assets/`, without the extension. */
  readonly name: string;
  /** The README's `alt` text, so this file is the source of the whole `<img>`. */
  readonly alt: string;
  readonly design: CountdownDesign;
}

/**
 * `borderColor` is set on every demo even where `borderWidth` is 0.
 *
 * It is not dead: `generateArtifacts` merges all three brand colours into the
 * GIF palette regardless of whether the border is drawn, so leaving it at the
 * default silently spends a palette slot on `#1a1a2e`. That is exactly what the
 * amber demo did, and it is invisible until you diff two colour tables.
 */
export const DEMOS: readonly Demo[] = [
  {
    name: 'demo-dark',
    alt: 'Animated countdown timer for email — dark theme',
    design: { ...DEFAULT_DESIGN, fontSize: 48 },
  },
  {
    name: 'demo-amber',
    alt: 'Countdown timer, amber on navy',
    design: {
      ...DEFAULT_DESIGN,
      fontSize: 44,
      boardBackground: '#0b2a4a',
      digitColor: '#ffd166',
      borderColor: '#1a1a2e',
    },
  },
  {
    name: 'demo-light',
    alt: 'Countdown timer, light theme with border',
    design: {
      ...DEFAULT_DESIGN,
      fontSize: 44,
      boardBackground: '#f4f4f5',
      digitColor: '#18181b',
      borderColor: '#d4d4d8',
      borderWidth: 2,
      dividerStyle: 'dot',
    },
  },
  {
    name: 'demo-minimal',
    alt: 'Minimal transparent countdown timer',
    design: {
      ...DEFAULT_DESIGN,
      fontSize: 40,
      units: ['hours', 'minutes', 'seconds'],
      showLabels: false,
      boardBackground: 'transparent',
      digitColor: '#e11d48',
      borderColor: '#e11d48',
    },
  },
];

function main(): void {
  const check = process.argv.includes('--check');
  const rows: string[] = [];
  let stale = 0;

  for (const demo of DEMOS) {
    // `now = 0`, `endsAt = REMAINING_MS`: the same call `/c.gif` makes, with the
    // clock pinned so the output is reproducible.
    const { gif } = renderCountdown(demo.design, REMAINING_MS, 0);
    const path = join(ASSETS_DIR, `${demo.name}.gif`);

    // The width an <img> must declare. The layout is in CSS px and the file is
    // `scale` times wider, so this is NOT the pixel width — see README.
    const cssWidth = layoutBoard(demo.design).width;
    const pixelWidth = cssWidth * demo.design.scale;

    if (check) {
      let current: Buffer | undefined;
      try {
        current = readFileSync(path);
      } catch {
        /* missing counts as stale */
      }
      const same = current !== undefined && Buffer.compare(current, Buffer.from(gif)) === 0;
      if (!same) stale++;
      console.log(`${same ? 'ok   ' : 'STALE'} ${demo.name}.gif`);
    } else {
      writeFileSync(path, Buffer.from(gif));
      console.log(
        `wrote ${`${demo.name}.gif`.padEnd(20)} ${String(pixelWidth).padStart(4)}px @${demo.design.scale}x` +
          ` -> width="${cssWidth}"  ${(gif.length / 1024).toFixed(1)} KB`,
      );
    }

    rows.push(`  <img src="assets/${demo.name}.gif" alt="${demo.alt}" width="${cssWidth}">`);
  }

  if (check) {
    if (stale > 0) {
      console.error(`\n${stale} demo(s) out of date — run \`pnpm demos\` and commit the result.`);
      process.exitCode = 1;
    }
    return;
  }

  console.log('\nREADME tags:\n');
  for (const row of rows) console.log(row);
}

// Only when run directly. `DEMOS` is exported for tests and one-off checks, and
// a module that overwrote four committed files just by being imported would be
// a trap — it caught this script's own author.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
