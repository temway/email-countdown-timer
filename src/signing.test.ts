import { describe, expect, it } from 'vitest';
import { canonicalize, sign, verify } from './signing.js';

const SECRET = 'correct horse battery staple';

describe('canonicalize', () => {
  it('sorts by key so parameter order cannot change the signature', () => {
    // Email clients and CDNs reorder query strings; a signature that depended
    // on order would break images in the wild.
    expect(canonicalize({ b: '2', a: '1' })).toBe(canonicalize({ a: '1', b: '2' }));
  });

  it('excludes the signature itself', () => {
    expect(canonicalize({ a: '1', sig: 'deadbeef' })).toBe('a=1');
  });

  it('drops empty and undefined values, matching the parser', () => {
    expect(canonicalize({ a: '1', b: '', c: undefined })).toBe('a=1');
  });
});

describe('verify', () => {
  const query = { until: '2026-12-25T00:00:00Z', size: '48' };

  it('accepts a signature it produced', () => {
    expect(verify(query, SECRET, sign(query, SECRET))).toBe(true);
  });

  it('accepts the same params in a different order', () => {
    const signature = sign({ size: '48', until: '2026-12-25T00:00:00Z' }, SECRET);
    expect(verify(query, SECRET, signature)).toBe(true);
  });

  it('rejects a missing signature', () => {
    expect(verify(query, SECRET, undefined)).toBe(false);
    expect(verify(query, SECRET, '')).toBe(false);
  });

  it('rejects a signature for different parameters', () => {
    const signature = sign({ ...query, size: '96' }, SECRET);
    expect(verify(query, SECRET, signature)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verify(query, SECRET, sign(query, 'wrong secret'))).toBe(false);
  });

  it('rejects a truncated signature without throwing', () => {
    // Unequal lengths must short-circuit: timingSafeEqual throws on a mismatch.
    expect(() => verify(query, SECRET, 'abc')).not.toThrow();
    expect(verify(query, SECRET, 'abc')).toBe(false);
  });

  it('ignores any sig already present in the params', () => {
    const signature = sign(query, SECRET);
    expect(verify({ ...query, sig: signature }, SECRET, signature)).toBe(true);
  });
});
