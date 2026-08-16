/**
 * The builder page served at `/`.
 *
 * Deliberately a single self-contained string: no bundler, no framework, no
 * assets to serve. The page's whole job is to let someone try the renderer in
 * ten seconds and leave with a snippet they can paste into an email — if it
 * needed a build step it would rot the first time the toolchain moved.
 */

import {
  MAX_BORDER_WIDTH,
  MAX_FONT_SIZE,
  MAX_LABEL_LENGTH,
  MAX_OUTPUT_WIDTH,
  MIN_FONT_SIZE,
} from '../params.js';
import { DEFAULT_DESIGN, UNIT_LABELS } from '../raster/options.js';
import { boardCssWidth } from './board-width.js';

const PAGE_TITLE = 'Countdown timer for email — builder';
const PAGE_DESCRIPTION =
  'Build a self-hosted animated countdown timer GIF for your email campaigns. Works in any ESP.';

/** `PUBLIC_ORIGIN` is operator-set, not user input, but a stray quote in it would
 *  still break every tag below out of its attribute. Cheaper to escape than to
 *  debug. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/**
 * @param signingEnabled  shows the notice explaining why built URLs will 401
 * @param origin          public origin; when omitted, every indexing tag is
 *                        left out. See {@link import('../config.js').Config.publicOrigin}.
 */
export function renderBuilderPage(signingEnabled: boolean, origin?: string): string {
  const signingNotice = signingEnabled
    ? `<p class="notice">URL signing is enabled on this instance, so URLs built here will not render until they are signed. See the README for <code>SIGNING_SECRET</code>.</p>`
    : '';

  // og:image carries no width/height on purpose: /og.png is rendered at the
  // board's natural aspect ratio, which shifts with the design it is generated
  // from. Declaring dimensions that disagree with the bytes is worse than making
  // a scraper measure them itself.
  const base = origin ? escapeAttr(origin) : '';
  const indexingTags = origin
    ? `
<link rel="canonical" href="${base}/">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Countdown timer for email">
<meta property="og:title" content="${PAGE_TITLE}">
<meta property="og:description" content="${PAGE_DESCRIPTION}">
<meta property="og:url" content="${base}/">
<meta property="og:image" content="${base}/og.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:alt" content="An animated countdown board showing days, hours, minutes and seconds remaining">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${PAGE_TITLE}">
<meta name="twitter:description" content="${PAGE_DESCRIPTION}">
<meta name="twitter:image" content="${base}/og.png">`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${PAGE_TITLE}</title>
<meta name="description" content="${PAGE_DESCRIPTION}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">${indexingTags}
<script>
  // Applied before first paint, so switching themes never flashes the other
  // one. Inline for the same reason the rest of this page is: no extra request.
  (function () {
    try {
      var saved = localStorage.getItem('ect-theme');
      var dark = saved ? saved === 'dark' : !window.matchMedia('(prefers-color-scheme: light)').matches;
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    } catch (e) {
      document.documentElement.dataset.theme = 'dark';
    }
  })();
</script>
<style>
  :root, [data-theme="dark"] {
    color-scheme: dark;
    --bg: #0f1017;
    --panel: #171923;
    --line: #262a38;
    --ink: #e8eaf2;
    --muted: #969cb3;
    --accent: #6ea8fe;
    --field: #0f1017;
    --code: #cdd3e6;
    --notice-bg: #2a2312;
    --notice-line: #5c4a1a;
    --notice-ink: #e8d9a8;
  }
  [data-theme="light"] {
    color-scheme: light;
    --bg: #f6f7fb;
    --panel: #ffffff;
    --line: #dfe3ee;
    --ink: #14161f;
    --muted: #5b6379;
    --accent: #2158cc;
    --field: #ffffff;
    --code: #2c3345;
    --notice-bg: #fdf6e3;
    --notice-line: #e3d19a;
    --notice-ink: #6b551a;
  }
  :root { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    line-height: 1.55; padding: 48px 24px 80px;
  }
  main { max-width: 900px; margin: 0 auto; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  h1 { font-size: 1.6rem; margin: 0 0 6px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); margin: 0 0 32px; }
  .preview {
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    padding: 32px; display: grid; place-items: center; min-height: 180px; margin-bottom: 8px;
  }
  .preview img { max-width: 100%; }
  .hint { color: var(--muted); font-size: 0.82rem; margin: 0 0 24px; }
  .fieldHint { display: block; color: var(--muted); font-size: 0.75rem; margin-top: 4px; }
  form {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 12px; padding: 24px; margin-bottom: 24px;
  }
  label { display: block; font-size: 0.78rem; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.06em; }
  input, select {
    width: 100%; padding: 9px 11px; border-radius: 8px; background: var(--field);
    border: 1px solid var(--line); color: var(--ink); font: inherit; font-size: 0.9rem;
  }
  input[type=color] { padding: 4px; height: 38px; }
  input:disabled { opacity: 0.45; cursor: not-allowed; }
  fieldset { border: 0; padding: 0; margin: 0; grid-column: 1 / -1; }
  .units { display: flex; flex-wrap: wrap; gap: 14px; }
  .units label { display: flex; align-items: center; gap: 7px; text-transform: none; letter-spacing: 0; font-size: 0.9rem; color: var(--ink); margin: 0; }
  .units input { width: auto; }
  .captions { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; }
  h2 { font-size: 0.78rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin: 28px 0 8px; }
  pre {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 16px; overflow-x: auto; font-size: 0.82rem; margin: 0 0 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--code);
  }
  button {
    background: transparent; border: 1px solid var(--line); color: var(--muted);
    padding: 7px 13px; border-radius: 8px; font: inherit; font-size: 0.82rem; cursor: pointer;
  }
  button:hover { color: var(--ink); border-color: var(--accent); }
  #theme { flex: none; }
  .notice { background: var(--notice-bg); border: 1px solid var(--notice-line); color: var(--notice-ink); padding: 12px 16px; border-radius: 8px; font-size: 0.88rem; }
  footer { margin-top: 44px; color: var(--muted); font-size: 0.85rem; border-top: 1px solid var(--line); padding-top: 20px; }
  footer p + p { margin-top: 12px; }
  footer a { text-decoration: underline; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>Countdown timer for email</h1>
      <p class="sub">Self-hosted animated GIFs that work in any ESP. Configure below, then paste the snippet into your email.</p>
    </div>
    <button type="button" id="theme">Light mode</button>
  </header>
  ${signingNotice}

  <div class="preview"><img id="preview" alt="Countdown preview"></div>
  <p class="notice" id="tooWide" aria-live="polite" hidden>That board is too wide to render — the image may be at most ${MAX_OUTPUT_WIDTH}px, which is 600px on screen at 2&times;. Reduce the digit size, drop a unit, shorten a caption, or untick Retina.</p>
  <p class="notice" id="previewError" aria-live="polite" hidden></p>
  <p class="hint">The preview is shown at the size it will occupy in an email, not at its pixel size. It sits on the page background — switch themes to check a transparent board against both a light and a dark email.</p>

  <form id="form">
    <div>
      <label for="until">Ends at (UTC)</label>
      <input type="datetime-local" id="until" name="until">
    </div>
    <div>
      <label for="size">Digit size</label>
      <input type="number" id="size" name="size" value="48" min="12" max="160">
      <span class="fieldHint" id="sizeMax"></span>
    </div>
    <div>
      <label for="divider">Divider</label>
      <select id="divider" name="divider">
        <option value="colon">Colon</option>
        <option value="dot">Dot</option>
        <option value="space">None</option>
      </select>
    </div>
    <div>
      <label for="shape">Shape</label>
      <select id="shape" name="shape">
        <option value="rounded">Rounded</option>
        <option value="rectangle">Square</option>
      </select>
    </div>
    <div>
      <label for="digit">Digit colour</label>
      <input type="color" id="digit" name="digit" value="#ffffff">
    </div>
    <div>
      <label for="board">Board colour</label>
      <input type="color" id="board" name="board" value="#1a1a2e">
    </div>
    <div>
      <label for="border">Border colour</label>
      <input type="color" id="border" name="border" value="#1a1a2e">
    </div>
    <div>
      <label for="borderWidth">Border width</label>
      <input type="number" id="borderWidth" name="borderWidth" value="0" min="0" max="24">
    </div>
    <fieldset>
      <label>Units</label>
      <div class="units">
        <label><input type="checkbox" name="unit" value="days" checked> Days</label>
        <label><input type="checkbox" name="unit" value="hours" checked> Hours</label>
        <label><input type="checkbox" name="unit" value="minutes" checked> Minutes</label>
        <label><input type="checkbox" name="unit" value="seconds" checked> Seconds</label>
        <label><input type="checkbox" id="labels" checked> Show labels</label>
        <label><input type="checkbox" id="transparent"> Transparent background</label>
        <label><input type="checkbox" id="retina" checked> Retina (2&times;)</label>
      </div>
    </fieldset>
    <fieldset>
      <label>Captions — leave blank for the default, max ${MAX_LABEL_LENGTH} characters</label>
      <div class="captions">
        <input type="text" name="labelDays" placeholder="${UNIT_LABELS.days}" maxlength="${MAX_LABEL_LENGTH}" aria-label="Days caption">
        <input type="text" name="labelHours" placeholder="${UNIT_LABELS.hours}" maxlength="${MAX_LABEL_LENGTH}" aria-label="Hours caption">
        <input type="text" name="labelMinutes" placeholder="${UNIT_LABELS.minutes}" maxlength="${MAX_LABEL_LENGTH}" aria-label="Minutes caption">
        <input type="text" name="labelSeconds" placeholder="${UNIT_LABELS.seconds}" maxlength="${MAX_LABEL_LENGTH}" aria-label="Seconds caption">
      </div>
    </fieldset>
  </form>

  <h2>Image URL</h2>
  <pre id="url"></pre>
  <button type="button" data-copy="url">Copy URL</button>

  <h2>Email HTML</h2>
  <pre id="snippet"></pre>
  <button type="button" data-copy="snippet">Copy HTML</button>

  <footer>
    <p>
      The <code>&lt;img&gt;</code> tag above renders the animated GIF. Outlook ignores GIF animation and shows
      the first frame, so the snippet points there directly — swap <code>.gif</code> for <code>.png</code> if
      you want a fully static image.
    </p>
    <p>
      Built by the team behind <a href="https://temway.com">Temway</a>, an on-brand email builder for teams
      and their AI agents — if you want a visual editor around timers like this one, that is what we make.
    </p>
  </footer>
</main>

<script>
${boardCssWidth.toString()}
</script>

<script>
  const form = document.getElementById('form');
  const preview = document.getElementById('preview');
  const urlEl = document.getElementById('url');
  const snippetEl = document.getElementById('snippet');
  const themeBtn = document.getElementById('theme');
  const retina = document.getElementById('retina');
  const tooWide = document.getElementById('tooWide');
  const previewError = document.getElementById('previewError');
  const sizeInput = document.getElementById('size');
  const sizeMaxEl = document.getElementById('sizeMax');
  const untilField = document.getElementById('until');
  const CAPTIONS = ['labelDays', 'labelHours', 'labelMinutes', 'labelSeconds'];
  const DEFAULT_LABELS = ${JSON.stringify(UNIT_LABELS)};

  // What to say when a load fails and the server cannot name the reason either.
  const LOAD_FAILURE = 'The preview failed to load. Check the connection, then change any setting to retry.';

  // The URL the preview was last pointed at — the error handler asks the server
  // about exactly this path, and only a build that requested can fail.
  let requestedPath = null;

  // Board width in CSS px per the last build(), from the same arithmetic the
  // server runs. Stand-in for the image's own width until one has loaded.
  let predictedCssWidth = 0;

  // An action button, not a state toggle: the label names what a click DOES.
  // An aria-pressed on top of a changing label announces the opposite state as
  // the current one, so it is deliberately absent.
  function paintThemeButton() {
    themeBtn.textContent =
      document.documentElement.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode';
  }

  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('ect-theme', next); } catch (e) { /* private mode */ }
    paintThemeButton();
  });

  paintThemeButton();

  // Default to one week out, rounded to the hour. The ISO string is kept
  // separately from the field: some mobile engines silently discard a value
  // set on a datetime-local input, and reading the field back then dropped
  // until from the first URL — which 400'd and was apologised for as a width
  // problem. The captured value fills the gap; the field is never written
  // back to, because fighting the platform was the original bug.
  const soon = new Date(Date.now() + 7 * 864e5);
  soon.setUTCMinutes(0, 0, 0);
  const defaultUntil = soon.toISOString();
  untilField.value = soon.toISOString().slice(0, 16);
  let untilTouched = false;
  untilField.addEventListener('input', () => { untilTouched = true; });

  function showLoadFailure(message) {
    previewError.textContent = message;
    previewError.hidden = false;
  }

  function build() {
    const showLabels = document.getElementById('labels').checked;
    for (const name of CAPTIONS) form[name].disabled = !showLabels;

    const units = [...document.querySelectorAll('input[name=unit]:checked')].map((el) => el.value);
    const scale = retina.checked ? 2 : 1;

    // An empty size or border field is omitted from the URL below and the
    // server's defaults apply — predict with those same defaults, so clearing
    // a field to retype it never flashes an error.
    const sizeRaw = sizeInput.value;
    const size = sizeRaw === '' ? ${DEFAULT_DESIGN.fontSize} : Number(sizeRaw);
    const bwRaw = form.borderWidth.value;
    const borderWidth = bwRaw === '' ? 0 : Number(bwRaw);

    // The caption list the prediction needs: the default where a field is
    // blank (the server's rule for blanks), and EMPTY with labels off — the
    // contract boardCssWidth is built around.
    const labelTexts = showLabels
      ? units.map((u) => form['label' + u.charAt(0).toUpperCase() + u.slice(1)].value.trim() || DEFAULT_LABELS[u])
      : [];

    // Predict with the server's own arithmetic, and publish the live ceiling
    // at the input: on a phone the notice under the preview is off-screen
    // while the form is being edited. The input's max only steers spinners
    // and validation — the typed value is never rewritten underneath anyone.
    const slotUnitCount = Math.max(1, units.length);
    predictedCssWidth = boardCssWidth(size, slotUnitCount, labelTexts, form.divider.value, borderWidth);
    let maxFit = 0;
    for (let s = ${MAX_FONT_SIZE}; s >= ${MIN_FONT_SIZE}; s--) {
      if (boardCssWidth(s, slotUnitCount, labelTexts, form.divider.value, borderWidth) * scale <= ${MAX_OUTPUT_WIDTH}) {
        maxFit = s;
        break;
      }
    }
    sizeInput.max = String(maxFit);
    sizeMaxEl.textContent = maxFit
      ? 'max ' + maxFit + ' at ' + scale + '× with ' + units.length + (units.length === 1 ? ' unit' : ' units')
      : 'no digit size fits this setup — untick Retina or drop a unit';

    // Every state the client KNOWS the server would reject (or silently fix
    // against what the checkboxes say) is caught here, in the order a person
    // would read the form — none of them should cost a round trip to discover.
    let blocked = null;
    let untilIso = null;
    const untilRaw = untilField.value;
    if (untilRaw) {
      const ms = Date.parse(untilRaw + 'Z');
      if (Number.isNaN(ms)) blocked = 'That end date is not valid — pick one from the calendar.';
      else untilIso = new Date(ms).toISOString();
    } else if (!untilTouched) {
      untilIso = defaultUntil;
    } else {
      blocked = 'Pick an end date to preview the timer.';
    }
    if (!blocked && !units.length) blocked = 'Tick at least one unit to preview the timer.';
    if (!blocked && (!Number.isInteger(size) || size < ${MIN_FONT_SIZE} || size > ${MAX_FONT_SIZE}))
      blocked = 'Digit size must be a whole number from ${MIN_FONT_SIZE} to ${MAX_FONT_SIZE}.';
    if (!blocked && (!Number.isInteger(borderWidth) || borderWidth < 0 || borderWidth > ${MAX_BORDER_WIDTH}))
      blocked = 'Border width must be a whole number from 0 to ${MAX_BORDER_WIDTH}.';

    const deviceWidth = predictedCssWidth * scale;
    if (!blocked && deviceWidth > ${MAX_OUTPUT_WIDTH}) blocked = 'width';

    // The URL always mirrors the form — it is copyable from a blocked state
    // too, with the notice saying plainly that it will not render yet.
    const params = new URLSearchParams();
    if (untilIso) params.set('until', untilIso);
    if (units.length) params.set('units', units.join(','));
    params.set('labels', showLabels ? '1' : '0');
    params.set('digit', form.digit.value.replace('#', ''));
    params.set('board', document.getElementById('transparent').checked ? 'transparent' : form.board.value.replace('#', ''));
    params.set('border', form.border.value.replace('#', ''));
    params.set('borderWidth', bwRaw);
    params.set('divider', form.divider.value);
    params.set('shape', form.shape.value);
    params.set('size', sizeRaw);
    params.set('scale', String(scale));
    if (showLabels) {
      // Omitted when blank, so a URL only carries the captions you changed.
      for (const name of CAPTIONS) {
        const value = form[name].value.trim();
        if (value) params.set(name, value);
      }
    }
    const path = '/c.gif?' + params.toString();
    urlEl.textContent = location.origin + path;

    if (blocked === 'width') {
      tooWide.textContent = maxFit
        ? 'That board would render ' + deviceWidth + 'px wide at ' + scale + '× — over the ' + ${MAX_OUTPUT_WIDTH} + 'px maximum. Largest digit size that fits: ' + maxFit + '. Take it, drop a unit, shorten a caption, or untick Retina.'
        : 'That board would render ' + deviceWidth + 'px wide at ' + scale + '× — over the ' + ${MAX_OUTPUT_WIDTH} + 'px maximum, and no digit size fits with these units and captions. Untick Retina, drop a unit, or shorten a caption.';
      tooWide.hidden = false;
      previewError.hidden = true;
    } else if (blocked) {
      showLoadFailure(blocked);
      tooWide.hidden = true;
    } else {
      tooWide.hidden = true;
      previewError.hidden = true;
      requestedPath = path;
      preview.src = path; // the only line that moves the preview — a blocked build keeps the last good one
    }
    renderSnippet();
  }

  function renderSnippet() {
    // The CSS width, which is what the <img> must declare — NOT the pixel
    // width. At scale=2 the file is twice as wide as it should be drawn, so an
    // <img> carrying the pixel width (or no width at all) renders double size
    // everywhere. Dividing here is the entire point of rendering at 2x.
    //
    // The loaded image stays the authority (ground truth beats prediction);
    // until one has loaded, the predicted width stands in — it knows about
    // captions, where the old size-times-7.5 guess did not.
    const scale = retina.checked ? 2 : 1;
    const width = preview.naturalWidth
      ? Math.round(preview.naturalWidth / scale)
      : Math.round(predictedCssWidth);
    // Show the preview at the size an email will draw it at, not at its pixel
    // size — otherwise a 2x board looks twice as big here as in the inbox.
    preview.style.width = width + 'px';
    snippetEl.textContent =
      '<a href="https://example.com/your-offer">\\n' +
      '  <img src="' + urlEl.textContent + '"\\n' +
      '       alt="Time remaining" width="' + width + '" style="display:block;border:0;">\\n' +
      '</a>';
  }

  preview.addEventListener('load', renderSnippet);
  // A failed load used to show the too-wide apology unconditionally — which is
  // how a missing until on a phone read as a width problem. Now the client
  // only requests URLs it has predicted valid, so a failure here means either
  // the server knows something the prediction does not (ask it, and show its
  // message verbatim — it names real pixel widths and signing errors) or
  // nobody knows (a network failure) — and width is never assumed.
  preview.addEventListener('error', () => {
    if (!requestedPath) return;
    fetch(requestedPath)
      .then((r) =>
        r.json().then(
          (body) => showLoadFailure(body && body.error ? body.error : LOAD_FAILURE),
          () => showLoadFailure(LOAD_FAILURE),
        ),
      )
      .catch(() => showLoadFailure(LOAD_FAILURE));
  });
  form.addEventListener('input', build);
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(document.getElementById(btn.dataset.copy).textContent);
      const original = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = original; }, 1200);
    });
  });

  build();
</script>
</body>
</html>`;
}
