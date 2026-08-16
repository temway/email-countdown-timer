/**
 * Render orchestration + caching.
 *
 * Stateless by design: a countdown is fully described by its design plus an end
 * date, both of which arrive in the URL. There is no database and no row to
 * look up — which is the whole reason this service can run offline from one
 * container.
 *
 * ## Two caches, two lifetimes
 *
 * 1. **Artifacts** (board + digit rasters) depend ONLY on the design, never on
 *    the clock. Rasterising is the expensive part of a cold request, so these
 *    are cached for the process lifetime and shared across every timer using the
 *    same design.
 * 2. **Rendered GIF/PNG pairs** depend on the design AND the remaining time, so
 *    they are cached per 20-second bucket (below).
 *
 * ## Why 20-second buckets
 *
 * Within a 20s window the animation is visually identical — the GIF runs 30
 * one-second frames, so a viewer who loads a slightly stale one sees the count
 * off by at most a fraction of a frame. Bucketing collapses a burst of requests
 * for the same timer into a single render. Cache TTL is deliberately SHORTER
 * than the bucket width so a stale entry can never outlive the window it was
 * accurate for.
 *
 * Both caches are per-process and bounded. The bound is not academic: every
 * distinct query string mints a distinct key, so on a public instance an
 * attacker could otherwise walk the parameter space and exhaust memory.
 */

import { generateArtifacts, type CountdownArtifacts } from './raster/index.js';
import { UNIT_NAMES, resolveUnitLabel, type CountdownDesign } from './raster/options.js';
import { renderCountdownGif } from './render/compositor.js';

/** Bucket width. See the module docstring for why 20s. */
export const BUCKET_WIDTH_MS = 20_000;

/**
 * Longest duration the board can display: `99d 23h 59m 59s`.
 *
 * Every unit gets exactly two digit slots, and the compositor reduces each
 * value with `% 10` per digit. A day count of 100 or more therefore WRAPS —
 * 130 days renders as "30", which is not a rounding artefact but a plainly
 * wrong number shown to a recipient.
 *
 * Clamping converts that into an obvious ceiling instead. A timer pinned at
 * `99:23:59:59` reads as "more than 99 days", where "30" reads as a lie. The
 * clamp lives here rather than in the compositor so the ported render core
 * stays byte-for-byte as it was proven.
 */
export const MAX_DISPLAYABLE_MS =
  99 * 86_400_000 + 23 * 3_600_000 + 59 * 60_000 + 59_000 + 999;

/** Strictly shorter than `BUCKET_WIDTH_MS`, so an entry never outlives its accuracy. */
const RENDER_CACHE_TTL_MS = 15_000;

/** Bounds on both caches. Exceeding either evicts oldest-first. */
const MAX_ARTIFACT_ENTRIES = 256;
const MAX_RENDER_ENTRIES = 1024;

export interface CountdownResult {
  readonly gif: Uint8Array;
  readonly png: Uint8Array;
  readonly expired: boolean;
  /**
   * True when the timer is further out than the board can display and is
   * pinned at `99:23:59:59`. See {@link MAX_DISPLAYABLE_MS}.
   */
  readonly clamped: boolean;
  /** Seconds until the next bucket boundary — drives CDN `s-maxage`. */
  readonly secondsToNextBucket: number;
}

interface RenderCacheEntry {
  readonly gif: Uint8Array;
  readonly png: Uint8Array;
  readonly expiresAt: number;
}

// Map iteration order is insertion order, so deleting the first key evicts the
// oldest entry — enough for a bounded cache without an LRU dependency.
const artifactCache = new Map<string, CountdownArtifacts>();
const renderCache = new Map<string, RenderCacheEntry>();

let lastEvictionMs = 0;
const EVICTION_THROTTLE_MS = 1000;

/**
 * A stable, collision-free key for a design.
 *
 * Field order is fixed here rather than relying on `JSON.stringify` of a
 * caller-built object, whose key order would depend on how it was constructed.
 */
export function designKey(design: CountdownDesign): string {
  return [
    design.units.join(','),
    design.showLabels ? '1' : '0',
    // RESOLVED captions, so an explicit `{days: 'DAYS'}` shares an entry with
    // the default — and percent-encoded, because a caption is free text that
    // could otherwise contain the `,` or `|` this key is delimited with and
    // collide with a different design. A collision here serves one caller's
    // image to another, which is worse than a cache miss by a wide margin.
    UNIT_NAMES.map((u) => encodeURIComponent(resolveUnitLabel(u, design.unitLabels))).join(','),
    design.digitColor,
    design.labelColor,
    design.boardBackground,
    design.borderColor,
    design.borderWidth,
    design.dividerStyle,
    design.shape,
    design.fontSize,
    // Omitting this would serve a 1x render for a 2x URL — the two designs are
    // otherwise identical, so they would share an entry and whichever rendered
    // first would win.
    design.scale,
  ].join('|');
}

function evictExpired(now: number): void {
  if (now - lastEvictionMs < EVICTION_THROTTLE_MS) return;
  lastEvictionMs = now;
  for (const [key, entry] of renderCache) {
    if (entry.expiresAt < now) renderCache.delete(key);
  }
}

function capSize(map: Map<string, unknown>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function getArtifacts(design: CountdownDesign): CountdownArtifacts {
  const key = designKey(design);
  const hit = artifactCache.get(key);
  if (hit) return hit;

  const artifacts = generateArtifacts(design);
  artifactCache.set(key, artifacts);
  capSize(artifactCache, MAX_ARTIFACT_ENTRIES);
  return artifacts;
}

/**
 * Render a countdown, or serve it from cache.
 *
 * @param design  the board design
 * @param endsAt  epoch ms the countdown expires at
 * @param now     epoch ms, injectable so tests need no fake timers
 */
export function renderCountdown(design: CountdownDesign, endsAt: number, now: number): CountdownResult {
  const remainingMs = endsAt - now;
  const expired = remainingMs <= 0;
  // The compositor treats 0 as "expired": one static all-zeros frame. The upper
  // clamp stops the two-digit day slot from wrapping — see MAX_DISPLAYABLE_MS.
  const effectiveMs = Math.min(MAX_DISPLAYABLE_MS, Math.max(0, remainingMs));
  const clamped = remainingMs > MAX_DISPLAYABLE_MS;
  const bucket = Math.floor(effectiveMs / BUCKET_WIDTH_MS);

  // An expired timer is frozen forever, and a clamped one does not change until
  // it falls back under the ceiling — both share a single cache entry rather
  // than minting a new bucket per request.
  const secondsToNextBucket =
    expired || clamped
      ? 300
      : Math.max(1, Math.ceil((effectiveMs - bucket * BUCKET_WIDTH_MS) / 1000));

  const key = `${designKey(design)}#${expired ? 'expired' : clamped ? 'clamped' : bucket}`;
  evictExpired(now);

  const cached = renderCache.get(key);
  if (cached && cached.expiresAt >= now) {
    return { gif: cached.gif, png: cached.png, expired, clamped, secondsToNextBucket };
  }

  const artifacts = getArtifacts(design);
  const out = renderCountdownGif(
    artifacts.board,
    artifacts.digits,
    artifacts.boardBoxes,
    artifacts.digitsBoxes,
    artifacts.colors,
    effectiveMs,
  );

  renderCache.set(key, {
    gif: out.gifBytes,
    png: out.pngBytes,
    expiresAt: now + RENDER_CACHE_TTL_MS,
  });
  capSize(renderCache, MAX_RENDER_ENTRIES);

  return { gif: out.gifBytes, png: out.pngBytes, expired, clamped, secondsToNextBucket };
}

/** Test hook — drops both caches. */
export function clearCaches(): void {
  artifactCache.clear();
  renderCache.clear();
  lastEvictionMs = 0;
}
