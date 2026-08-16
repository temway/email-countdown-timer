/**
 * Runtime configuration, all optional.
 *
 * The service must start and render correctly with NO environment set — that is
 * the offline promise, and it is the first thing the Docker smoke test checks.
 */

export interface Config {
  readonly port: number;
  readonly host: string;
  /**
   * When set, every request must carry a matching `sig` HMAC. Off by default:
   * a self-hosted instance behind your own CDN usually doesn't need it, and a
   * mandatory secret would make the quick-start a three-step process.
   *
   * Turn it on for a public instance — without it, anyone can point your renderer
   * at arbitrary parameters and use your CPU.
   */
  readonly signingSecret?: string;
  /**
   * Public origin of this instance, e.g. `https://countdown.example.com`.
   *
   * Set it and the builder page gains canonical, Open Graph and Twitter tags and
   * the sitemap starts resolving. Leave it unset — the default — and all of that
   * is omitted rather than guessed.
   *
   * Omitting is the point. Deriving the origin from the `Host` header would work
   * through any sane proxy, but it would also hand a self-hosted instance our
   * canonical URLs, telling Google that someone's private timer service is a
   * duplicate of the public demo. A canonical tag you did not ask for is worse
   * than no canonical tag.
   *
   * Trailing slashes are stripped so callers can append paths unconditionally.
   */
  readonly publicOrigin?: string;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(): Config {
  const secret = process.env.SIGNING_SECRET;
  const origin = process.env.PUBLIC_ORIGIN?.trim().replace(/\/+$/, '');
  return {
    port: intFromEnv('PORT', 8080),
    host: process.env.HOST ?? '0.0.0.0',
    signingSecret: secret && secret.length > 0 ? secret : undefined,
    publicOrigin: origin && origin.length > 0 ? origin : undefined,
  };
}
