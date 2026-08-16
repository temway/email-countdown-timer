/**
 * Inline icons.
 *
 * Kept as a string rather than a file in a `public/` directory for the same
 * reason the builder page is one: this service has no static-file surface, and
 * adding one for 300 bytes of SVG would mean a `serveStatic` mount, a
 * `cwd`-relative root that differs between `pnpm dev` and the container, and a
 * new way for the image to be missing at runtime.
 */

/**
 * Two digit tiles in the renderer's own default colours — board `#1a1a2e`,
 * digits `#ffffff`. It is the product at 16 pixels.
 *
 * A hairline border keeps the dark tiles from disappearing into a dark browser
 * tab strip; without it the favicon reads as empty space on most dark themes.
 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<g fill="#1a1a2e" stroke="#4a4a6a" stroke-width="1">
<rect x="1.5" y="6.5" width="13" height="19" rx="3"/>
<rect x="17.5" y="6.5" width="13" height="19" rx="3"/>
</g>
<g fill="none" stroke="#ffffff" stroke-width="2.5">
<rect x="5.25" y="11.25" width="5.5" height="9.5" rx="2.75"/>
<rect x="21.25" y="11.25" width="5.5" height="9.5" rx="2.75"/>
</g>
</svg>`;
