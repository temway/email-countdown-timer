/**
 * HTTP surface: two image routes, a health check, and a builder page.
 *
 * ## Cache-Control
 *
 * `s-maxage` is aligned to the next 20-second bucket boundary so a CDN
 * revalidates exactly when the server-side cache would roll over — a viewer
 * never sees a frame more than one bucket stale. `max-age` is shorter still,
 * because a browser serves one person while a CDN serves millions and benefits
 * far more from the cache.
 *
 * Expired timers are frozen forever, so both jump to five minutes.
 *
 * ## A caveat worth knowing before you ship this
 *
 * Gmail proxies and caches remote images. Every email countdown timer on the
 * market has this problem, including the paid ones: the proxy may serve one
 * cached frame to a recipient rather than re-fetching. Short `max-age` helps but
 * does not fully defeat it. Treat a countdown as a strong visual cue, not a
 * to-the-second clock.
 */

import { Hono } from 'hono';
import { loadConfig, type Config } from './config.js';
import { parseCountdownParams } from './params.js';
import { DEFAULT_DESIGN } from './raster/options.js';
import { renderCountdown } from './service.js';
import { verify } from './signing.js';
import { renderBuilderPage } from './ui/builder.js';
import { FAVICON_SVG } from './ui/icons.js';

/**
 * Copy a render's bytes into a standalone `ArrayBuffer`.
 *
 * These are typed `Uint8Array` but are Node `Buffer`s at runtime (pngjs and
 * gifenc both return one), and `Buffer.prototype.slice` is an ALIAS FOR
 * `subarray` — a view, not a copy. So `bytes.slice().buffer` yields the whole
 * shared 8KB allocation pool rather than the image: a corrupt response, and a
 * disclosure of whatever else was allocated beside it. Only images at or above
 * 4KB escape the pool, which is why this looked fine for a default-sized GIF and
 * broke for a small PNG.
 *
 * Copying the exact range is correct for a Buffer and a Uint8Array both.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * The social card render.
 *
 * `fontSize` is the maximum the parser allows, which puts the board at 1208px
 * wide — about the width every card scraper wants. The remaining time is a fixed
 * offset from `now` rather than a real date, so `renderCountdown` sees the same
 * duration on every request and the render-cache key stays constant instead of
 * minting a fresh bucket per scrape.
 *
 * The odd `13s` is deliberate: it puts the duration mid-bucket. On an exact
 * 20-second boundary a sub-millisecond difference between reading the clock and
 * subtracting it would land either side of `Math.floor`, and the card would
 * re-render at full size on roughly half of all requests.
 */
const OG_DESIGN = { ...DEFAULT_DESIGN, fontSize: 160 };
const OG_REMAINING_MS = 3 * 86_400_000 + 7 * 3_600_000 + 42 * 60_000 + 13_000;

export function createApp(config: Config = loadConfig()): Hono {
  const app = new Hono();
  const origin = config.publicOrigin;
  const canonicalHost = origin ? new URL(origin).host : undefined;

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/', (c) => {
    // Send the builder to its canonical host before it builds anything. This is
    // not really an SEO measure — the canonical tag already covers that. It is
    // that src/ui/builder.ts derives the image URL from `location.origin`, so a
    // visitor who lands on the raw *.fly.dev hostname would otherwise copy a
    // snippet pointing at infrastructure we intend to be able to move. Those
    // URLs end up in sent email, where they can never be corrected.
    //
    // Read off `c.req.url` rather than the `Host` header: @hono/node-server
    // builds that URL from the incoming Host anyway, and `Host` is a forbidden
    // header name in the Fetch spec, so reading it directly returns undefined
    // for any request that came from a constructed `Request` rather than a
    // socket — which is every request in the test suite.
    const host = new URL(c.req.url).host;
    if (canonicalHost && host !== canonicalHost) {
      return c.redirect(`${origin}/`, 301);
    }
    return c.html(renderBuilderPage(Boolean(config.signingSecret), origin));
  });

  app.get('/favicon.svg', (c) =>
    c.body(FAVICON_SVG, 200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
    }),
  );

  // Browsers and feed readers still probe this path unprompted; answering costs
  // less than the 404s cost to read in the logs.
  app.get('/favicon.ico', (c) => c.redirect('/favicon.svg', 301));

  app.get('/og.png', (c) => {
    // One clock read, used for both ends: two calls could straddle a
    // millisecond and shift the duration the cache key is derived from.
    const now = Date.now();
    const result = renderCountdown(OG_DESIGN, now + OG_REMAINING_MS, now);
    return c.body(toArrayBuffer(result.png), 200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=3600',
      'Content-Disposition': 'inline',
    });
  });

  app.get('/robots.txt', (c) =>
    c.text(
      // The image routes are an UNBOUNDED url space — every query string is a
      // distinct URL — so a crawler walking them is precisely the compute abuse
      // the CDN rules exist to stop, arriving from Googlebot IPs that a
      // rate limit will happily wave through. They are also worthless in an
      // image index: any `until` in the past renders an all-zeros board.
      //
      // With no PUBLIC_ORIGIN this is somebody's private instance. It does not
      // get indexed by default.
      origin
        ? `User-agent: *\nDisallow: /c.gif\nDisallow: /c.png\nSitemap: ${origin}/sitemap.xml\n`
        : 'User-agent: *\nDisallow: /\n',
      200,
      { 'Cache-Control': 'public, max-age=86400' },
    ),
  );

  app.get('/sitemap.xml', (c) => {
    // A sitemap advertising the wrong host is worse than no sitemap.
    if (!origin) return c.notFound();
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `  <url><loc>${origin}/</loc></url>\n` +
        `</urlset>\n`,
      200,
      { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=86400' },
    );
  });

  for (const ext of ['gif', 'png'] as const) {
    app.get(`/c.${ext}`, (c) => {
      const query = c.req.query();

      if (config.signingSecret && !verify(query, config.signingSecret, query.sig)) {
        return c.json({ error: 'invalid or missing signature' }, 401);
      }

      const parsed = parseCountdownParams(query);
      if (!parsed.ok) {
        return c.json({ error: parsed.error }, 400);
      }

      const { design, endsAt } = parsed.value;
      const result = renderCountdown(design, endsAt, Date.now());

      // Both an expired timer and one clamped at the 99-day ceiling show a
      // frame that will not change for a long time, so both cache hard.
      const frozen = result.expired || result.clamped;
      const maxAge = frozen ? 300 : 60;
      const sMaxAge = frozen ? 300 : result.secondsToNextBucket;
      const bytes = ext === 'gif' ? result.gif : result.png;

      return c.body(toArrayBuffer(bytes), 200, {
        'Content-Type': ext === 'gif' ? 'image/gif' : 'image/png',
        'Cache-Control': `public, max-age=${maxAge}, s-maxage=${sMaxAge}`,
        // Guards an old Safari quirk where an animated GIF served without an
        // explicit disposition downloads instead of displaying.
        'Content-Disposition': 'inline',
      });
    });
  }

  return app;
}
