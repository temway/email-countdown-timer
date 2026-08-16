/**
 * Optional HMAC URL signing.
 *
 * A public renderer with unsigned URLs is an open compute endpoint: anyone can
 * point it at arbitrary parameters and spend your CPU. Signing binds a URL to
 * the person who generated it.
 *
 * The signature covers the query parameters sorted by key, so it is stable
 * regardless of the order an email client or CDN happens to reorder them into —
 * which they do. `sig` itself is excluded, obviously.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Canonical string signed: `k=v` pairs sorted by key, joined with `&`. */
export function canonicalize(query: Record<string, string | undefined>): string {
  return Object.entries(query)
    .filter(([key, value]) => key !== 'sig' && value !== undefined && value !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

export function sign(query: Record<string, string | undefined>, secret: string): string {
  return createHmac('sha256', secret).update(canonicalize(query)).digest('hex');
}

/** Constant-time comparison, so a signature can't be recovered by timing. */
export function verify(
  query: Record<string, string | undefined>,
  secret: string,
  provided: string | undefined,
): boolean {
  if (!provided) return false;
  const expected = sign(query, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
