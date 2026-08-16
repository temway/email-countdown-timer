/**
 * Guards the golden-image fixtures' *presence*.
 *
 * The golden tests in this directory regenerate a missing fixture from the
 * current output and then assert against the bytes they just wrote. That is
 * convenient when deliberately re-baselining, and dangerous otherwise: a
 * missing fixture makes them pass while checking nothing.
 *
 * This is not hypothetical. On first commit these files were silently dropped
 * by a `__*__` pattern in a global gitignore, which would have shipped a repo
 * whose headline "the ported compositor is provably unchanged" test suite was
 * vacuous for every person who cloned it.
 *
 * So: assert the bytes exist and are non-trivial, before anything gets to
 * regenerate them.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

/**
 * Every fixture the suites in this directory read, with a floor on plausible
 * size. Listed explicitly because that is the point — the failure mode being
 * guarded is a file going missing.
 */
const REQUIRED_FIXTURES: ReadonlyArray<readonly [string, number]> = [
  ['golden.gif', 4000],
  ['golden.png', 100],
  ['real-capture/board.png', 1000],
  ['real-capture/digits.png', 1000],
  ['real-capture/boardBoxes.json', 50],
  ['real-capture/digitsBoxes.json', 50],
  ['real-capture/colors.json', 20],
  ['real-capture/golden.gif', 4000],
  ['real-capture/golden.png', 100],
];

describe('golden-image fixtures are committed', () => {
  it.each(REQUIRED_FIXTURES)('%s exists and is non-trivial', (relative, minBytes) => {
    const file = path.join(FIXTURES_DIR, relative);
    expect(existsSync(file), `missing fixture: ${relative}`).toBe(true);
    expect(readFileSync(file).length, `suspiciously small: ${relative}`).toBeGreaterThan(minBytes);
  });

  it('checks every fixture the golden suites depend on', () => {
    // Non-vacuity: a shrinking list would quietly narrow this guard.
    expect(REQUIRED_FIXTURES.length).toBe(9);
  });
});
