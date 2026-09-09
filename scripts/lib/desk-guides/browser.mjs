// Real geometry, measured in a real browser.
//
// This module exists because the checks that look sufficient are not. A clean
// `scrollHeight`/`scrollWidth` result says nothing about ink: page B's core-loop
// strip rendered "Orient" as "Orien" and "worktree" as "worktre" while every
// element reported no overflow, because opaque, negatively-margined cells painted
// over their neighbours' text. Occlusion is a distinct failure mode from overflow
// and gets its own assertion. So does line count -- descriptions estimated at
// seven lines reached twelve, and all eight cards overflowed a 145px box.
//
// Chromium is NOT in scripts/lib/toolchain.mjs and must not be added to it.
// `tier` there means "a machine of yours is misconfigured without this", which is
// false for someone who cloned the public export to scaffold a repo. This is a
// task-specific prerequisite, probed here, never installed automatically.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export class BrowserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserError';
  }
}

const fail = (message) => { throw new BrowserError(message); };

/** Candidates in preference order, per platform. Edge before Chrome on Windows
 *  because Edge is present on every supported Windows install and Chrome is not,
 *  and because the six hand-built pages were fitted and printed from Edge -- the
 *  measurements this gate enforces were taken there.
 *
 *  That preference is unchanged by #252 and the order here is deliberately not the
 *  place the Edge-is-silent problem was fixed: reordering would re-baseline every
 *  shipped page onto Chrome on every machine, including the ones where Edge works.
 *  `findBrowser()` reaches past a candidate only where that candidate has proved,
 *  on this machine and this run, that it produces nothing at all. */
export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const pf = env['ProgramFiles'] ?? 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA ?? '';
    return [
      `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      ...(local ? [`${local}\\Google\\Chrome\\Application\\chrome.exe`] : []),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return [
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
}

const INSTALL_HINT = {
  win32: 'Microsoft Edge ships with Windows; if it was removed, install Edge or Google Chrome.',
  darwin: 'Install Microsoft Edge or Google Chrome from the vendor, or `brew install --cask google-chrome`.',
  linux: 'Install one of: microsoft-edge-stable, google-chrome-stable, chromium.',
};

/** The capability probe, and the page it measures nothing about.
 *
 *  A candidate that exists is not a candidate that works. Edge 151 and Edge 152
 *  on Windows both exit 0 having written zero bytes for `--headless --dump-dom`,
 *  and zero bytes for `--version` too -- which points at the binary rather than
 *  at the flags, and means no flag combination is worth sniffing for. Existence
 *  was the only check discovery made until #252, so on such a machine it chose
 *  the one browser present that cannot do the job.
 *
 *  The probe page carries no script and asserts no geometry. It proves the binary
 *  dumps a DOM at all; everything past that is the real measurement's business. */
export const PROBE_SENTINEL = 'dg-browser-probe';
export const PROBE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>probe</title></head>
<body><p id="${PROBE_SENTINEL}">ok</p></body></html>
`;

/** Launch one candidate over the probe page and report whether it answered.
 *
 *  Invoked through `browserArgs()`, deliberately: a probe that exercises some
 *  other invocation proves something the gate never asks for. The staging
 *  directory is this function's own -- `mkdtempSync` returns a path nothing else
 *  holds -- which is what makes removing it compatible with CLAUDE.md
 *  constraint 5. A profile directory inside it keeps the probe from attaching to
 *  a browser still shutting down, per the note in `browserArgs()`. */
export function probeBrowser(candidate, { run = defaultRun, tmpRoot = tmpdir() } = {}) {
  const dir = mkdtempSync(join(tmpRoot, 'dg-browser-probe-'));
  try {
    const page = join(dir, 'probe.html');
    writeFileSync(page, PROBE_HTML, 'utf8');
    const result = run(candidate, browserArgs(pathToFileURL(page).href, {
      widthPx: 800, heightPx: 600, budgetMs: 5000, userDataDir: join(dir, 'browser'),
    }));
    if (result?.error) return false;
    return (result?.stdout ?? '').includes(PROBE_SENTINEL);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // A temp directory Windows still holds open is not a reason to refuse a
      // browser that just proved it works. It is under the OS temp root and the
      // OS clears it; failing discovery over it would trade a real capability
      // for a tidiness that nothing depends on.
    }
  }
}

const PROBE_CACHE = new Map();

const defaultWarn = (message) => { process.stderr.write(`${message}\n`); };

/** The first candidate that exists AND answers, or a refusal that says how to fix
 *  it. Nothing here installs anything -- the design forbids it, and a generator
 *  that installs a browser to print a reference card has misjudged its own
 *  importance.
 *
 *  Falling through to a second engine is announced rather than silent (#252). The
 *  six shipped pages were fitted and printed on Edge, so a run that reaches Chrome
 *  measures them on an engine the baseline was not taken from. That is better than
 *  not measuring at all, which is where a silent Edge leaves the gate, and worse
 *  than knowing -- so the run says which engine it used and why.
 *
 *  `run` is injected so the whole selection is testable without a browser; the
 *  per-process probe cache is bypassed for an injected `run`, because a cached
 *  answer from a different stub is not an answer about this one. */
export function findBrowser({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  run = defaultRun,
  cache = run === defaultRun ? PROBE_CACHE : new Map(),
  warn = defaultWarn,
  tmpRoot = tmpdir(),
} = {}) {
  const answers = (candidate) => {
    if (!cache.has(candidate)) cache.set(candidate, probeBrowser(candidate, { run, tmpRoot }));
    return cache.get(candidate);
  };

  // A pin is an instruction, not a preference. Falling through from it would
  // measure on the engine the operator just said not to use, which is the one
  // thing naming an engine explicitly exists to prevent -- so a pin that cannot
  // work refuses here, rather than at measurement time as a page fault.
  const pinned = (env.DAFTPLATE_BROWSER ?? '').trim();
  if (pinned) {
    if (!exists(pinned)) {
      fail(`DAFTPLATE_BROWSER=${pinned} does not exist. Unset it to search the usual locations.`);
    }
    if (!answers(pinned)) {
      fail(`DAFTPLATE_BROWSER=${pinned} exists but produced no output for a trivial page, so it cannot measure a real one. Unset it to search the usual locations.`);
    }
    return pinned;
  }

  const reasons = [];
  const silent = [];
  for (const candidate of browserCandidates(platform, env)) {
    if (!exists(candidate)) { reasons.push(`${candidate} -- absent`); continue; }
    if (!answers(candidate)) {
      reasons.push(`${candidate} -- present but produced no output`);
      silent.push(candidate);
      continue;
    }
    if (silent.length) {
      warn(`desk-guides: ${silent.join(' and ')} produced no output for a trivial page; measuring with ${candidate} instead.`);
      warn(`desk-guides: the shipped pages were fitted and printed on the preferred engine, so this run's measurements come from a different one. Set DAFTPLATE_BROWSER to pin an engine.`);
    }
    return candidate;
  }
  fail(`no usable Chromium-family browser found. ${INSTALL_HINT[platform] ?? INSTALL_HINT.linux} Set DAFTPLATE_BROWSER to a working Chromium-family binary if one is installed elsewhere. Tried:\n  ${reasons.join('\n  ')}`);
  return null;
}

/** Flags verified against Edge on Windows. `--dump-dom` is what makes the
 *  measurement readable without a driver library; the window size is the Letter
 *  landscape page at CSS 96dpi, so a page that fits the viewport is a page that
 *  fits the paper. */
export function browserArgs(fileUrl, { widthPx, heightPx, budgetMs = 30000, userDataDir = null }) {
  return [
    '--headless',
    // A profile directory of our own, created inside this run's staging area.
    // Without it a launch can attach to a browser process still shutting down
    // from the previous page and exit immediately with no output at all -- which
    // arrives here as "no completion sentinel", indistinguishable from a crash.
    // Measured 2026-08-23: intermittent, and always on the first page of a run.
    ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${widthPx},${heightPx}`,
    `--virtual-time-budget=${budgetMs}`,
    '--dump-dom',
    fileUrl,
  ];
}

/** The completion sentinel. Its absence is fatal: a browser that crashed halfway
 *  dumps a partial DOM with no findings element, and "no findings" is the same
 *  shape as "no problems". Reading a crash as CLEAN is the failure this whole
 *  module is built to avoid.
 *
 *  Absent from an EMPTY dump it means something else, and `measure()` says so
 *  separately (#252). A partial DOM is evidence about the page; zero bytes is
 *  evidence about the binary, which never got as far as the page. */
export const SENTINEL = 'dg-status="complete"';
const FINDINGS_RE = /<div id="dg-findings"[^>]*>([A-Za-z0-9+/=]*)<\/div>/;

/**
 * The measurement, as page JavaScript.
 *
 * Base64 rather than raw JSON in the DOM, because the serializer escapes `&` and
 * `<` on the way out and an un-escaping step is one more place to be subtly
 * wrong. Base64 is inert to HTML serialization and a truncated dump fails to
 * decode rather than decoding to something plausible.
 */
export function probeScript({ contract, layout }) {
  // The polling wrapper is not stylistic. `--dump-dom` serializes the DOM as soon
  // as the page settles, and `--virtual-time-budget` only holds it back while a
  // virtual timer is pending. A probe that waits for `load` before scheduling its
  // first timer races the dump and loses intermittently -- the run then fails with
  // "no completion sentinel", which reads as a browser crash. Scheduling from
  // parse time keeps a timer pending continuously, so the dump waits for the
  // measurement instead of the other way round. Measured 2026-08-23.
  return `<script>(function () {
  let started = false;
  function tick() {
    if (document.readyState !== 'complete') { setTimeout(tick, 20); return; }
    if (started) return;
    started = true;
    run();
  }
  setTimeout(tick, 20);

  async function run() {
  const CONTRACT = ${JSON.stringify(contract)};
  const LAYOUT = ${JSON.stringify(layout)};
  const PT = 72 / 96;
  const findings = [];
  const add = (f) => findings.push(f);
  const round = (n) => Math.round(n * 100) / 100;

  // The probe's own failure must be a FINDING, not an absent sentinel. Those two
  // read identically from outside -- "the browser said nothing" -- and only one of
  // them is a crash. Reporting the throw keeps the other one meaning what it says.
  try {
  try { await document.fonts.ready; } catch (e) { /* no web fonts: nothing to await */ }
  await new Promise((r) => setTimeout(r, 30));

  const pageOf = (el) => (el.closest('[data-dg-page]') || {}).dataset?.dgPage || '?';
  const idOf = (el) => el.dataset.dgId || el.tagName.toLowerCase() + '.' + (el.className || '?').split(' ')[0];

  // --- page geometry ------------------------------------------------------
  for (const pageEl of document.querySelectorAll('[data-dg-page]')) {
    const rect = pageEl.getBoundingClientRect();
    const wantW = LAYOUT.pageWidthIn * 96;
    const wantH = LAYOUT.pageHeightIn * 96;
    if (Math.abs(rect.width - wantW) > 1 || Math.abs(rect.height - wantH) > 1) {
      add({ type: 'geometry', page: pageEl.dataset.dgPage, id: 'page',
            actual: round(rect.width) + 'x' + round(rect.height),
            expected: wantW + 'x' + wantH,
            message: 'page box is not Letter landscape at 96dpi' });
    }
  }

  // --- computed type and line height --------------------------------------
  for (const el of document.querySelectorAll('[data-dg-role]')) {
    const role = el.dataset.dgRole;
    const want = CONTRACT[role];
    if (!want) continue;
    const style = getComputedStyle(el);
    const sizePt = parseFloat(style.fontSize) * PT;
    if (sizePt < want.minSizePt - 0.01) {
      add({ type: 'type', page: pageOf(el), id: idOf(el), role,
            actual: round(sizePt), expected: want.minSizePt,
            message: role + ' text computes to ' + round(sizePt) + 'pt, below the ' + want.minSizePt + 'pt floor' });
    }
    const lh = style.lineHeight === 'normal'
      ? parseFloat(style.fontSize) * 1.2
      : parseFloat(style.lineHeight);
    const ratio = lh / parseFloat(style.fontSize);
    if (ratio < want.minLineHeight - 0.005) {
      add({ type: 'lineHeight', page: pageOf(el), id: idOf(el), role,
            actual: round(ratio), expected: want.minLineHeight,
            message: role + ' line-height computes to ' + round(ratio) });
    }
    if (/condensed|narrow/i.test(style.fontFamily)) {
      add({ type: 'font', page: pageOf(el), id: idOf(el), role,
            actual: style.fontFamily, expected: 'no condensed face',
            message: 'a condensed face is in the resolved family list' });
    }
  }

  // --- overflow -----------------------------------------------------------
  // Only boxes that actually CLIP. \`scrollHeight > clientHeight\` on an
  // \`overflow: visible\` element is not lost ink -- the content spills, and the
  // spill is caught by whichever ancestor does clip. Flagging it anyway produces
  // a standing false positive on every page title, which is precisely how a gate
  // stops being read. The 27pt masthead h1 is the documented instance.
  const TOL = LAYOUT.overflowTolerancePx;
  for (const el of document.querySelectorAll('.dg-page, .dg-page *')) {
    if (!el.clientHeight) continue;
    const s = getComputedStyle(el);
    const clipsY = s.overflowY !== 'visible';
    const clipsX = s.overflowX !== 'visible';
    if (!clipsY && !clipsX) continue;
    const oy = clipsY ? el.scrollHeight - el.clientHeight : 0;
    const ox = clipsX ? el.scrollWidth - el.clientWidth : 0;
    if (oy > TOL || ox > TOL) {
      add({ type: 'overflow', page: pageOf(el), id: idOf(el),
            actual: 'y' + oy + ',x' + ox, expected: '<=' + TOL,
            message: 'content is clipped by its own box, exceeding it by y' + oy + ' x' + ox + 'px' });
    }
  }

  // --- measured line count -------------------------------------------------
  const textRects = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) continue;
    // The element's identity and page are resolved ONCE here. Both walk the
    // ancestor chain, and calling them from inside the collision sweep pushed the
    // probe past the virtual-time budget -- the browser dumped a partial DOM and
    // the run failed with no sentinel rather than with a finding.
    const el = node.parentElement;
    const id = idOf(el);
    const page = pageOf(el);
    for (const r of rects) textRects.push({ el, node, rect: r, id, page });
  }

  // The budget belongs to the ELEMENT, not to the page. "Descriptions are
  // normally one line and never more than two" is a rule about descriptions; a
  // profile card or a stop band is neither, and holding those to the same number
  // measures something nobody meant. Each constrained block declares its own
  // budget in \`data-dg-lines\`, emitted from the same layout policy.
  for (const el of document.querySelectorAll('[data-dg-lines]')) {
    const limit = Number(el.dataset.dgLines);
    if (!Number.isFinite(limit) || limit <= 0) continue;
    const rects = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = w.nextNode(); node; node = w.nextNode()) {
      if (!node.nodeValue.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      rects.push(...[...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5));
    }
    if (!rects.length) continue;
    // Distinct rendered line positions, not newline characters and not an
    // estimate: rounded tops of the actual line boxes.
    const lines = new Set(rects.map((r) => Math.round(r.top))).size;
    if (lines > limit) {
      add({ type: 'lineCount', page: pageOf(el), id: idOf(el),
            actual: lines, expected: limit,
            text: (el.textContent || '').trim().slice(0, 60),
            message: 'renders on ' + lines + ' lines, over its ' + limit + '-line budget' });
    }
  }

  // --- occlusion -----------------------------------------------------------
  // A distinct failure mode from overflow, and the one that shipped. Only
  // OPAQUE painters count: a transparent or non-painting box that geometrically
  // overlaps text is ordinary nested layout, and treating every intersection as
  // lost ink would reject every card on every page.
  const opaque = (style) => {
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (parseFloat(style.opacity) < 1) return false;
    if (style.backgroundImage && style.backgroundImage !== 'none') return true;
    const m = (style.backgroundColor || '').match(/rgba?\\(([^)]+)\\)/);
    if (!m) return false;
    const parts = m[1].split(',').map((s) => parseFloat(s));
    return parts.length < 4 || parts[3] >= 1;
  };
  const stackLevel = (el) => {
    const s = getComputedStyle(el);
    if (s.position !== 'static' && s.zIndex !== 'auto') return Number(s.zIndex) || 0;
    return 0;
  };
  const clippedRect = (el) => {
    let rect = el.getBoundingClientRect();
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflow === 'visible' && s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const pr = p.getBoundingClientRect();
      rect = {
        left: Math.max(rect.left, pr.left), right: Math.min(rect.right, pr.right),
        top: Math.max(rect.top, pr.top), bottom: Math.min(rect.bottom, pr.bottom),
      };
    }
    return rect;
  };
  const painters = [...document.querySelectorAll('.dg-page *')]
    .filter((el) => opaque(getComputedStyle(el)))
    .map((el) => ({ el, rect: clippedRect(el), level: stackLevel(el) }));

  for (const { el, rect, id, page } of textRects) {
    const textLevel = stackLevel(el);
    for (const painter of painters) {
      if (painter.el === el) continue;
      const rel = el.compareDocumentPosition(painter.el);
      // Never an ancestor or a descendant: a card's own background sits behind
      // its own text by definition, and a child cannot occlude its parent's line
      // box without being that line box.
      if (rel & Node.DOCUMENT_POSITION_CONTAINED_BY) continue;
      if (rel & Node.DOCUMENT_POSITION_CONTAINS) continue;
      const above = painter.level > textLevel
        || (painter.level === textLevel && Boolean(rel & Node.DOCUMENT_POSITION_FOLLOWING));
      if (!above) continue;
      const overlapW = Math.min(rect.right, painter.rect.right) - Math.max(rect.left, painter.rect.left);
      const overlapH = Math.min(rect.bottom, painter.rect.bottom) - Math.max(rect.top, painter.rect.top);
      if (overlapW <= 0.5 || overlapH <= 0.5) continue;
      add({ type: 'occlusion', page, id,
            text: (el.textContent || '').trim().slice(0, 60),
            occludedBy: idOf(painter.el),
            actual: round(overlapW) + 'x' + round(overlapH) + 'px',
            expected: 'no opaque sibling over text',
            message: 'text is painted over by ' + idOf(painter.el) });
      break;
    }
  }

  // --- text over text ---------------------------------------------------------
  // The gap the opaque-painter rule cannot see, found by looking at a page the
  // gate had just called clean: page B's B3 table printed across the footer's
  // provenance line. Neither box has a background, so nothing "paints over"
  // anything -- two runs of text simply occupy the same rectangle and both become
  // unreadable. Distinct from overflow (each box fitted its own parent) and from
  // occlusion (no opaque painter involved).
  //
  // Compared at the level of role-bearing BOXES rather than individual line
  // rectangles. A page carries a few hundred text rectangles and only about a
  // hundred role boxes, and the pairwise sweep over rectangles did not finish
  // inside the virtual-time budget. Boxes are also the right granularity: what
  // went wrong was one block printed across another, and a finding naming two
  // blocks is actionable in a way that one naming two line fragments is not.
  const boxes = [...document.querySelectorAll('[data-dg-role]')]
    .filter((el) => (el.textContent || '').trim() !== '')
    // The CLIPPED rectangle, not the raw one: content an ancestor has already
    // cut away does not reach the box it geometrically overlaps, and reporting it
    // twice -- once as overflow, once as a collision -- buries the finding that
    // names the actual remedy.
    .map((el) => ({ el, rect: clippedRect(el), id: idOf(el), page: pageOf(el) }))
    .filter((b) => b.rect.right - b.rect.left > 0.5 && b.rect.bottom - b.rect.top > 0.5);

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const w = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (w <= 1 || h <= 1) continue;
      // Nested markup shares a box with its parent by design: a <b> inside a <p>
      // is a word in bold, not a collision.
      const rel = a.el.compareDocumentPosition(b.el);
      if (rel & Node.DOCUMENT_POSITION_CONTAINED_BY) continue;
      if (rel & Node.DOCUMENT_POSITION_CONTAINS) continue;
      add({ type: 'collision', page: a.page, id: a.id,
            text: (a.el.textContent || '').trim().slice(0, 60),
            occludedBy: b.id,
            actual: round(w) + 'x' + round(h) + 'px',
            expected: 'no two text boxes in the same rectangle',
            message: 'text shares a rectangle with ' + b.id + '; both are unreadable there' });
    }
  }

  } catch (err) {
    add({ type: 'probe', page: '?', id: 'probe',
          actual: String((err && err.stack) || err), expected: 'the probe runs to completion',
          message: 'the layout probe threw: ' + String((err && err.message) || err) });
  }

  const box = document.createElement('div');
  box.id = 'dg-findings';
  box.setAttribute('hidden', '');
  box.textContent = btoa(unescape(encodeURIComponent(JSON.stringify(findings))));
  document.body.appendChild(box);
  document.documentElement.setAttribute('data-dg-status', 'complete');
  }
})();</` + `script>`;
}

/** Inject the probe into a copy of the page. The printable artifact never carries
 *  script: what is measured is the same markup plus one appended block, and what
 *  is printed is the markup alone. */
export function instrument(html, probe) {
  if (!html.includes('</head>')) fail('page HTML has no </head> to instrument');
  return html.replace('</head>', `${probe}\n</head>`);
}

/** Run the browser over one instrumented file and return its findings.
 *  Every argument is a separate array element and `shell: false`, so no command
 *  string is built and a path with a space cannot become two arguments. */
export function measure({ browserPath, filePath, contract, layout, run = defaultRun, budgetMs, userDataDir }) {
  const args = browserArgs(pathToFileURL(filePath).href, {
    widthPx: Math.round(layout.pageWidthIn * 96),
    heightPx: Math.round(layout.pageHeightIn * 96),
    ...(budgetMs ? { budgetMs } : {}),
    ...(userDataDir ? { userDataDir } : {}),
  });
  const result = run(browserPath, args);
  if (result.error) fail(`${browserPath} could not be run: ${result.error.message}`);
  const dom = result.stdout ?? '';
  // An empty dump and a sentinel-less dump are different faults, and they shared
  // one message until #252. A browser that writes nothing at all never loaded the
  // page, so accusing the page accuses the wrong thing -- and it sends the reader
  // hunting a layout bug that is not there while the binary is the problem.
  if (dom.trim() === '') {
    fail(`${browserPath} produced no output at all for ${filePath} (exit ${result.status ?? '?'}); that is a fault in the browser, not in the page, because a page that crashes still dumps a partial DOM. Set DAFTPLATE_BROWSER to a working Chromium-family binary.`);
  }
  if (!dom.includes(SENTINEL)) {
    fail(`the browser produced no completion sentinel for ${filePath}; the dump is truncated or the page crashed, and an absent findings list is not a clean one`);
  }
  const match = dom.match(FINDINGS_RE);
  if (!match) fail(`the browser completed but emitted no findings element for ${filePath}`);
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  } catch (err) {
    fail(`the browser findings for ${filePath} could not be decoded: ${err.message}`);
  }
  if (!Array.isArray(parsed)) fail(`the browser findings for ${filePath} are not a list`);
  return parsed;
}

const defaultRun = (command, args) =>
  spawnSync(command, args, { shell: false, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

/** Write the instrumented copy beside the page and measure it. Returns findings. */
export function validatePage({ browserPath, htmlPath, html, probePath, contract, layout, run, budgetMs, userDataDir }) {
  writeFileSync(probePath, instrument(html, probeScript({ contract, layout })), 'utf8');
  return measure({ browserPath, filePath: probePath, contract, layout, run, budgetMs, userDataDir })
    .map((finding) => ({ ...finding, source: htmlPath }));
}

/** The contract the probe checks computed style against, derived from the same
 *  layout policy html.mjs emits CSS from. */
export function typeContract(layout) {
  return {
    title: { minSizePt: layout.minBodyPt, minLineHeight: layout.minLineHeight },
    heading: { minSizePt: layout.minBodyPt, minLineHeight: layout.minLineHeight },
    primary: { minSizePt: layout.bodyPt, minLineHeight: layout.minLineHeight },
    secondary: { minSizePt: layout.minBodyPt, minLineHeight: layout.minLineHeight },
    footer: { minSizePt: layout.minFooterPt, minLineHeight: layout.minLineHeight },
  };
}
