import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { MAX_LABEL_LENGTH, unitLabelParam } from './params.js';
import { UNIT_NAMES } from './raster/options.js';
import { clearCaches } from './service.js';
import { sign } from './signing.js';

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

const app = createApp({ port: 0, host: '127.0.0.1' });

function get(path: string, instance = app) {
  return instance.request(path);
}

beforeEach(() => {
  clearCaches();
});

describe('/health', () => {
  it('reports ok', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('/ builder page', () => {
  it('serves HTML', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('<form');
  });

  it('mentions signing only when it is enabled', async () => {
    const off = await get('/');
    expect(await off.text()).not.toContain('SIGNING_SECRET');

    const on = createApp({ port: 0, host: '127.0.0.1', signingSecret: 's3cret' });
    expect(await (await get('/', on)).text()).toContain('SIGNING_SECRET');
  });

  it('ships both page modes and a control to switch between them', async () => {
    const html = await (await get('/')).text();
    expect(html).toContain('[data-theme="light"]');
    expect(html).toContain('[data-theme="dark"]');
    expect(html).toContain('id="mode"');
    // Persisted, or the choice is lost on every reload.
    expect(html).toContain("localStorage.setItem('ect-theme'");
  });

  it('resolves the theme before the body renders, so it cannot flash', async () => {
    const html = await (await get('/')).text();
    const script = html.indexOf('prefers-color-scheme');
    const body = html.indexOf('<body');
    expect(script).toBeGreaterThan(-1);
    expect(script).toBeLessThan(body);
  });

  it('offers a caption input for every unit', async () => {
    const html = await (await get('/')).text();
    for (const unit of UNIT_NAMES) {
      expect(html, unit).toContain(`name="${unitLabelParam(unit)}"`);
    }
    // The cap is enforced server-side; the input should not invite a 400.
    expect(html).toContain(`maxlength="${MAX_LABEL_LENGTH}"`);
  });
});

describe('/c.gif', () => {
  it('returns an animated GIF', async () => {
    const res = await get(`/c.gif?until=${encodeURIComponent(FUTURE)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes.slice(0, 6)).toString('ascii')).toBe('GIF89a');
  });

  it('serves inline, guarding an old Safari download quirk', async () => {
    const res = await get(`/c.gif?until=${encodeURIComponent(FUTURE)}`);
    expect(res.headers.get('content-disposition')).toBe('inline');
  });

  it('aligns CDN cache lifetime to the bucket boundary', async () => {
    const res = await get(`/c.gif?until=${encodeURIComponent(FUTURE)}`);
    const cacheControl = res.headers.get('cache-control') ?? '';
    expect(cacheControl).toMatch(/^public, max-age=60, s-maxage=\d+$/);

    const sMaxAge = Number(cacheControl.match(/s-maxage=(\d+)/)?.[1]);
    expect(sMaxAge).toBeGreaterThanOrEqual(1);
    expect(sMaxAge).toBeLessThanOrEqual(20);
  });

  it('caches an expired timer for five minutes, since it never changes again', async () => {
    const res = await get(`/c.gif?until=${encodeURIComponent(PAST)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
  });
});

describe('/c.png', () => {
  it('returns the Outlook fallback still', async () => {
    const res = await get(`/c.png?until=${encodeURIComponent(FUTURE)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

/**
 * Regression: the route used to hand Hono `bytes.slice().buffer`, believing
 * `.slice()` copies. It does for a `Uint8Array` — but these are Node `Buffer`s,
 * whose `.slice()` is an alias for `subarray`, so `.buffer` was the whole
 * shared 8KB pool. Any image under 4KB was served as a corrupt 8192-byte body
 * containing unrelated heap bytes. Images over 4KB skip the pool, so the
 * default GIF hid it.
 *
 * Asserting on the terminator catches every variant of this: a padded, short,
 * or offset body cannot end with the right bytes.
 */
describe('response bodies are exactly the image', () => {
  // Deliberately tiny, to land inside the pool where the bug lived.
  const SMALL = `until=${encodeURIComponent(FUTURE)}&size=12&units=seconds&labels=0`;

  it('ends a PNG at its IEND chunk', async () => {
    for (const query of [SMALL, `until=${encodeURIComponent(FUTURE)}`]) {
      const bytes = new Uint8Array(await (await get(`/c.png?${query}`)).arrayBuffer());
      expect(Array.from(bytes.slice(0, 4)), query).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(Buffer.from(bytes.slice(-8)).toString('hex'), query).toBe('49454e44ae426082');
    }
  });

  it('ends a GIF at its trailer byte', async () => {
    for (const query of [SMALL, `until=${encodeURIComponent(FUTURE)}`]) {
      const bytes = new Uint8Array(await (await get(`/c.gif?${query}`)).arrayBuffer());
      expect(Buffer.from(bytes.slice(0, 6)).toString('ascii'), query).toBe('GIF89a');
      expect(bytes[bytes.length - 1], query).toBe(0x3b);
    }
  });

  it('exercises an image small enough to have been pooled', async () => {
    // Non-vacuity. Node pools allocations under 4KB; anything larger gets its
    // own exact ArrayBuffer and would have passed the assertions above even
    // with the bug present. If this ever stops holding, the two tests above
    // have quietly stopped covering the case they were written for.
    const bytes = new Uint8Array(await (await get(`/c.png?${SMALL}`)).arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThan(4096);
  });
});

describe('validation', () => {
  it('400s a missing until', async () => {
    const res = await get('/c.gif');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/until/);
  });

  it('400s an out-of-range size rather than rendering a huge image', async () => {
    const res = await get(`/c.gif?until=${encodeURIComponent(FUTURE)}&size=100000`);
    expect(res.status).toBe(400);
  });

  it('400s an unknown enum value', async () => {
    const res = await get(`/c.gif?until=${encodeURIComponent(FUTURE)}&shape=blob`);
    expect(res.status).toBe(400);
  });

  it('400s an over-long caption', async () => {
    const long = 'W'.repeat(MAX_LABEL_LENGTH + 1);
    const res = await get(`/c.gif?until=${encodeURIComponent(FUTURE)}&labelDays=${long}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/labelDays/);
  });

  it('400s an unknown theme, naming the valid ones', async () => {
    const res = await get(`/c.gif?until=${encodeURIComponent(FUTURE)}&theme=neon`);
    expect(res.status).toBe(400);
    const error = ((await res.json()) as { error: string }).error;
    expect(error).toMatch(/^theme: /);
    expect(error).toContain('dark');
  });

  it('renders a themed request end to end', async () => {
    const res = await get(`/c.gif?until=${encodeURIComponent(FUTURE)}&theme=amber`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
    expect(Buffer.from(new Uint8Array(await res.arrayBuffer()).slice(0, 6)).toString('ascii')).toBe(
      'GIF89a',
    );
  });

  it('renders a themed request differently from the default board', async () => {
    const plain = await get(`/c.gif?until=${encodeURIComponent(FUTURE)}`);
    const themed = await get(`/c.gif?until=${encodeURIComponent(FUTURE)}&theme=amber`);
    const a = new Uint8Array(await plain.arrayBuffer());
    const b = new Uint8Array(await themed.arrayBuffer());
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0);
  });

  it('renders custom captions end to end', async () => {
    const query = new URLSearchParams({
      until: FUTURE,
      labelDays: 'TAGE',
      labelHours: 'STD',
      labelMinutes: 'MIN',
      labelSeconds: 'SEK',
    });
    const res = await get(`/c.gif?${query}`);
    expect(res.status).toBe(200);

    const custom = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(custom.slice(0, 6)).toString('ascii')).toBe('GIF89a');

    // And is not silently serving the default board from cache.
    const plain = new Uint8Array(
      await (await get(`/c.gif?until=${encodeURIComponent(FUTURE)}`)).arrayBuffer(),
    );
    expect(Buffer.from(custom)).not.toEqual(Buffer.from(plain));
  });

  it('renders a fully customised request', async () => {
    const query = new URLSearchParams({
      until: FUTURE,
      units: 'minutes,seconds',
      labels: '0',
      digit: 'ff0000',
      board: 'transparent',
      border: '00ff00',
      borderWidth: '3',
      divider: 'dot',
      shape: 'rectangle',
      size: '32',
    });
    const res = await get(`/c.gif?${query}`);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});

/**
 * Everything below is gated on `PUBLIC_ORIGIN`. The gate is the point: a
 * self-hosted instance that sets no environment must not advertise the public
 * demo's canonical URLs, nor invite a crawler onto an endpoint that renders an
 * image per unique query string.
 */
describe('indexing', () => {
  const ORIGIN = 'https://countdown.example.com';
  const published = createApp({ port: 0, host: '127.0.0.1', publicOrigin: ORIGIN });

  describe('with no PUBLIC_ORIGIN set', () => {
    it('tells crawlers to stay off entirely', async () => {
      const res = await get('/robots.txt');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('User-agent: *\nDisallow: /\n');
    });

    it('has no sitemap to advertise', async () => {
      expect((await get('/sitemap.xml')).status).toBe(404);
    });

    it('omits canonical and social tags rather than guessing a host', async () => {
      const html = await (await get('/')).text();
      expect(html).not.toContain('rel="canonical"');
      expect(html).not.toContain('og:url');
      expect(html).not.toContain('twitter:card');
    });

    it('still serves the builder on any host, since there is nothing to redirect to', async () => {
      const res = await get('/');
      expect(res.status).toBe(200);
    });
  });

  describe('with PUBLIC_ORIGIN set', () => {
    it('keeps crawlers off the image routes but lets them index the page', async () => {
      const body = await (await get('/robots.txt', published)).text();
      expect(body).toContain('Disallow: /c.gif');
      expect(body).toContain('Disallow: /c.png');
      expect(body).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
      expect(body).not.toMatch(/^Disallow: \/$/m);
    });

    it('serves a sitemap pointing at the canonical origin', async () => {
      const res = await get('/sitemap.xml', published);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/xml/);
      expect(await res.text()).toContain(`<loc>${ORIGIN}/</loc>`);
    });

    it('emits canonical, Open Graph and Twitter tags', async () => {
      const html = await (await published.request(`${ORIGIN}/`)).text();
      expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/">`);
      expect(html).toContain(`content="${ORIGIN}/og.png"`);
      expect(html).toContain('twitter:card');
    });

    /**
     * The builder derives its image URL from `location.origin`, so a visitor on
     * the raw platform hostname would copy a snippet pointing at infrastructure
     * we want to stay free to move. Those URLs live in sent email forever and
     * cannot be corrected afterwards, which makes this a durability guard rather
     * than a duplicate-content one.
     */
    it('301s the builder to its canonical host', async () => {
      const res = await published.request('https://email-countdown-demo.fly.dev/');
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
    });

    it('does not redirect a request already on the canonical host', async () => {
      const res = await published.request(`${ORIGIN}/`);
      expect(res.status).toBe(200);
    });

    /**
     * Never redirect the image routes: a 301 on an email image adds a round trip
     * to every proxy fetch and breaks outright in some clients.
     */
    it('leaves the image routes alone on a non-canonical host', async () => {
      const url = `https://email-countdown-demo.fly.dev/c.gif?until=${encodeURIComponent(FUTURE)}`;
      const res = await published.request(url);
      expect(res.status).toBe(200);
    });
  });
});

describe('page assets', () => {
  it('serves an inline favicon', async () => {
    const res = await get('/favicon.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(await res.text()).toContain('<svg');
  });

  it('points legacy /favicon.ico probes at the SVG', async () => {
    const res = await get('/favicon.ico');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/favicon.svg');
  });

  it('renders the social card through the normal render path', async () => {
    const res = await get('/og.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(Buffer.from(bytes.slice(-8)).toString('hex')).toBe('49454e44ae426082');
  });

  it('holds the social card still, so it is not re-rendered per scrape', async () => {
    // A fixed remaining time means a constant render-cache key. If this ever
    // returns two different images, /og.png has started minting a bucket per
    // request and the most expensive design in the app is rendering on demand.
    const first = new Uint8Array(await (await get('/og.png')).arrayBuffer());
    const second = new Uint8Array(await (await get('/og.png')).arrayBuffer());
    expect(Buffer.from(first)).toEqual(Buffer.from(second));
  });
});

describe('signing', () => {
  const signed = createApp({ port: 0, host: '127.0.0.1', signingSecret: 's3cret' });

  it('401s an unsigned request when signing is on', async () => {
    const res = await get(`/c.gif?until=${encodeURIComponent(FUTURE)}`, signed);
    expect(res.status).toBe(401);
  });

  it('401s a wrongly signed request', async () => {
    const query = { until: FUTURE };
    const bad = sign(query, 'other secret');
    const res = await get(`/c.gif?until=${encodeURIComponent(FUTURE)}&sig=${bad}`, signed);
    expect(res.status).toBe(401);
  });

  it('serves a correctly signed request', async () => {
    const query = { until: FUTURE, size: '32' };
    const sig = sign(query, 's3cret');
    const url = `/c.gif?until=${encodeURIComponent(FUTURE)}&size=32&sig=${sig}`;
    const res = await get(url, signed);
    expect(res.status).toBe(200);
  });

  it('rejects a request whose parameters were tampered with after signing', async () => {
    const sig = sign({ until: FUTURE, size: '32' }, 's3cret');
    const url = `/c.gif?until=${encodeURIComponent(FUTURE)}&size=96&sig=${sig}`;
    expect((await get(url, signed)).status).toBe(401);
  });
});
