import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo } from './helpers/make-repo.mjs';
import { loadConfig } from '../scripts/lib/desk-guides/config.mjs';
import { buildPages, buildA1, buildA2, buildB, buildC, buildD, buildE } from '../scripts/lib/desk-guides/pages.mjs';
import {
  renderPage, renderBundle, renderPageBody, sharedCss, esc, PAGE_FILES,
} from '../scripts/lib/desk-guides/html.mjs';
import {
  browserCandidates, findBrowser, probeBrowser, validatePage, typeContract, measure,
  SENTINEL, PROBE_SENTINEL,
} from '../scripts/lib/desk-guides/browser.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = loadConfig(readFileSync(join(ROOT, 'desk-guides.config.json'), 'utf8'));
const META = { date: '2026-08-23', version: '9.9.9', commit: 'abc1234' };

// A frozen inventory: no discovery, no machine, no clock. Everything the page
// builders read is here, so a test failure is a change in the builders.
const INVENTORY = {
  entries: [
    { key: 'claude:orient', tool: 'claude', skill: 'orient', disposition: 'shown', page: 'A1', group: 'start' },
    { key: 'claude:brief', tool: 'claude', skill: 'brief', disposition: 'shown', page: 'A1', group: 'start' },
    { key: 'claude:audit', tool: 'claude', skill: 'audit', disposition: 'omitted', reason: 'not selected' },
    { key: 'codex:docs@m:documents', tool: 'codex', skill: 'documents', disposition: 'shown', page: 'A2', group: 'docs' },
    { key: 'codex:docs@m:redline', tool: 'codex', skill: 'redline', disposition: 'omitted', reason: 'not selected' },
    { key: 'codex:personal:hatch', tool: 'codex', skill: 'hatch', disposition: 'omitted', reason: 'personal root', eligibleForCard: false },
    { key: 'profile:alpha:feature-flow', tool: 'profile', profile: 'alpha', skill: 'feature-flow', disposition: 'shown', page: 'C', group: 'cards' },
  ],
  profiles: [
    { name: 'alpha', summary: 'Choose alpha.', adds: 'Alpha step.', rule: 'Alpha rule.', verify: 'npm run build', test: 'npm test', deploy: '/land-and-deploy', docsSubdirs: ['designs', 'adr'] },
    { name: 'beta', summary: 'Choose beta.', adds: 'Beta step.', rule: 'Beta rule.', verify: 'node scripts/validate.mjs', test: 'n/a', deploy: 'n/a', docsSubdirs: ['designs', 'adr'] },
    { name: 'gamma', summary: 'Choose gamma.', adds: 'Gamma step.', rule: 'Gamma rule.', verify: 'npm test', test: 'npm test', deploy: 'n/a', docsSubdirs: ['designs', 'adr'] },
    { name: 'delta', summary: 'Choose delta.', adds: 'Delta step.', rule: 'Delta rule.', verify: 'npm test', test: 'npm test', deploy: 'n/a', docsSubdirs: ['designs', 'adr'] },
  ],
  sources: [],
  counts: { shown: 4, grouped: 0, omitted: 3 },
  families: [],
};

/** The committed configuration reduced to the frozen inventory's keys, so the
 *  page builders are exercised against policy that actually resolves. */
function frozenConfig(overrides = {}) {
  const raw = JSON.parse(readFileSync(join(ROOT, 'desk-guides.config.json'), 'utf8'));
  const profile = (name) => ({ summary: `Choose ${name}.`, adds: `${name} step.`, rule: `${name} rule.` });
  raw.profiles = { alpha: profile('alpha'), beta: profile('beta'), gamma: profile('gamma'), delta: profile('delta') };
  raw.selected = [
    { key: 'claude:orient', page: 'A1', group: 'start', summary: 'Use when starting.' },
    { key: 'claude:brief', page: 'A1', group: 'start', summary: 'Use when terse.' },
    { key: 'codex:docs@m:documents', label: 'documents', page: 'A2', group: 'docs', summary: 'Edit Word files.' },
    { key: 'profile:alpha:feature-flow', page: 'C', group: 'cards', summary: 'Trace a feature.' },
  ];
  raw.families = [];
  raw.omitted = [];
  return loadConfig(JSON.stringify({ ...raw, ...overrides }));
}

// ---------------------------------------------------------------------------
// Task 2.1 -- page models
// ---------------------------------------------------------------------------

test('A1 prints every configured shown Claude entry exactly once, in configured order', () => {
  // Mutation killed: the builder reads all discoveries instead of the configured
  // selection, or drops selected entries. Exact ordered keys, not a count: a
  // count passes when one entry is swapped for another.
  const a1 = buildA1(frozenConfig(), INVENTORY);
  const keys = a1.groups.flatMap((group) => group.entries.map((entry) => entry.key));
  assert.deepEqual(keys, ['claude:orient', 'claude:brief']);
  assert.equal(new Set(keys).size, keys.length);
});

test('A2 refuses to print a Codex entry that is not an installed and enabled plugin row', () => {
  // Mutation killed: a disposition of `shown` is trusted on its own, so an
  // ineligible discovery -- a personal-root skill, a cache entry -- leaks from the
  // inventory onto a card whose heading claims everything on it is live.
  const config = frozenConfig({
    selected: [
      { key: 'claude:orient', page: 'A1', group: 'start', summary: 'Use when starting.' },
      { key: 'claude:brief', page: 'A1', group: 'start', summary: 'Use when terse.' },
      { key: 'profile:alpha:feature-flow', page: 'C', group: 'cards', summary: 'Trace a feature.' },
      { key: 'codex:personal:hatch', label: 'hatch', page: 'A2', group: 'docs', summary: 'A personal skill.' },
    ],
  });
  const inventory = {
    ...INVENTORY,
    entries: INVENTORY.entries
      .filter((e) => e.key !== 'codex:docs@m:documents')
      .map((e) => (e.key === 'codex:personal:hatch'
        ? { ...e, disposition: 'shown', page: 'A2', group: 'docs' } : e)),
  };
  assert.throws(() => buildA2(config, inventory), /is not an installed and enabled plugin row/);
});

test('the A2 footer derives shown and discovered from two different places', () => {
  // Mutation killed: both numbers come from the printed list, so "shown 1 of 1" is
  // true by construction on a page whose purpose is to say how much it omitted.
  //
  // The gap is carried by `codex:docs@m:redline` -- an ELIGIBLE plugin row that is
  // simply not selected. It used to be carried by the ineligible personal skill,
  // which made this test pass for the wrong reason and pinned the defect in #247:
  // the two-sources property was real, but the number proving it was wrong.
  const a2 = buildA2(frozenConfig(), INVENTORY);
  assert.equal(a2.counts.shown, 1);
  assert.equal(a2.counts.discovered, 2);      // one shown, one omitted plugin row
  assert.notEqual(a2.counts.shown, a2.counts.discovered);
});

test('the A2 footer total excludes a discovery that is not an installed plugin row', () => {
  // Mutation killed: `eligibleOnly` is dropped, or the predicate is inverted, so
  // `codex:personal:hatch` is counted. The page header says "installed and enabled
  // only" and the footer names `codex plugin list` as the command to check it
  // against -- a personal-root skill appears in neither, so counting it makes the
  // one number that invites verification the one that fails it. #247 (FORGE-321).
  //
  // Asserted against the label rather than only the number: the count reaches the
  // reader as a sentence, and a correct total rendered into the wrong sentence is
  // the same defect.
  const a2 = buildA2(frozenConfig(), INVENTORY);
  const ineligible = INVENTORY.entries.filter((e) => e.key.startsWith('codex:') && e.eligibleForCard === false);
  assert.equal(ineligible.length, 1, 'the fixture no longer carries an ineligible codex entry to exclude');
  const allCodex = INVENTORY.entries.filter((e) => e.key.startsWith('codex:')).length;
  assert.equal(a2.counts.discovered, allCodex - ineligible.length);
  assert.match(a2.countsLabel, /^Installed and enabled: 2 - shown: 1 - verify: codex plugin list$/);
});

test('the A1 footer counts every discovery, because "found" is not a claim about eligibility', () => {
  // Mutation killed: the A2 filter is applied blanket-fashion to both pages --
  // flipping `eligibleOnly`'s default to true, or dropping the option and always
  // filtering. A1 says "Claude skills found", which is a statement about
  // discovery; narrowing it would make the page under-report what exists, which
  // is the inverse of the #247 defect and just as wrong.
  //
  // The inventory is built here rather than taken from INVENTORY, and the reason
  // is worth stating: discovery sets `eligibleForCard: false` ONLY on the Codex
  // personal and repo slots (`discovery.mjs`), so no `claude:` entry carries it
  // today and the shared fixture cannot express one. Running the blanket mutant
  // against INVENTORY therefore kills nothing -- measured, not assumed. This test
  // pins the intended semantics of the two labels rather than a reachable state,
  // and it is the only thing standing between them if a future discovery source
  // ever marks a Claude entry ineligible.
  const withIneligible = {
    ...INVENTORY,
    entries: [
      ...INVENTORY.entries,
      { key: 'claude:vendored', tool: 'claude', skill: 'vendored', disposition: 'omitted', reason: 'not a user-level skill', eligibleForCard: false },
    ],
  };
  const a1 = buildA1(frozenConfig(), withIneligible);
  const allClaude = withIneligible.entries.filter((e) => e.key.startsWith('claude:')).length;
  assert.equal(allClaude, 4);
  assert.equal(a1.counts.discovered, allClaude, 'A1 narrowed "found" to an eligibility claim');
  assert.match(a1.countsLabel, /Claude skills found: 4 -/);
});

test('C prints every discovered profile with the commands the profile parser returned', () => {
  // Mutation killed: the profile list or the command strings are hard-coded. A
  // fourth fixture profile with a distinctive verify command kills both.
  const c = buildC(frozenConfig(), INVENTORY);
  assert.deepEqual(c.profiles.map((p) => p.name), ['alpha', 'beta', 'gamma', 'delta']);
  assert.equal(c.profiles[1].verify, 'node scripts/validate.mjs');
  assert.equal(c.profiles[0].deploy, '/land-and-deploy');
  assert.deepEqual(c.grid, { columns: 2, rows: 2 });
  assert.equal(c.profiles[0].adds, 'Alpha step.');
  assert.equal(c.profiles[0].rule, 'Alpha rule.');
});

test('an unapproved profile count fails with a content-density error, not a smaller font', () => {
  // Mutation killed: the grid is computed arithmetically, so a fifth profile is
  // silently squeezed into a layout that no longer meets the type contract.
  const inventory = { ...INVENTORY, profiles: [...INVENTORY.profiles, { ...INVENTORY.profiles[0], name: 'epsilon' }] };
  const config = frozenConfig({
    profiles: Object.fromEntries(['alpha', 'beta', 'gamma', 'delta', 'epsilon']
      .map((n) => [n, { summary: `Choose ${n}.`, adds: `${n} step.`, rule: `${n} rule.` }])),
  });
  assert.throws(() => buildC(config, inventory), /5 profiles has no approved card grid/);
});

test('B keeps the core loop in configured order with every stop gate', () => {
  // Mutation killed: the steps are alphabetized, or a callout is dropped. The
  // order IS the content on this page -- the loop reads left to right -- and an
  // alphabetized loop is still a list of the right words.
  const b = buildB(CONFIG);
  assert.deepEqual(b.loop.map((s) => s.label), CONFIG.workflow.loop);
  assert.equal(b.loop[0].label, 'Orient');
  assert.equal(b.loop.at(-1).label, 'handoff/learn');
  assert.deepEqual(b.callouts, CONFIG.workflow.callouts);
  assert.ok(b.callouts.some((line) => /does NOT create the git tag/.test(line)));
});

test('every B overlap row carries one winner and one bounded exception', () => {
  // Mutation killed: the model renders neutral alternatives. A row with a winner
  // and no exception is the two-options-presented-fairly shape this section
  // exists to replace.
  const b = buildB(CONFIG);
  for (const row of b.overlaps) {
    assert.ok(row.winner.trim(), `${row.overlap} has no winner`);
    assert.ok(row.exception.trim(), `${row.overlap} has no exception`);
  }
  assert.throws(
    () => buildB(loadConfig(JSON.stringify({
      ...JSON.parse(readFileSync(join(ROOT, 'desk-guides.config.json'), 'utf8')),
      workflow: { ...CONFIG.workflow, overlaps: [] },
    }))),
    /workflow\.overlaps/,
  );
});

test('D names the annotated tag and the GitHub Release, the two steps /ship omits', () => {
  // Mutation killed: the release sequence ends at branch close. Those two steps
  // are the page's reason to exist and a print-acceptance item, so their absence
  // is fatal rather than a shorter card.
  const d = buildD(CONFIG);
  const release = d.sections[1].items.join(' ');
  assert.match(release, /Annotated vX\.Y\.Z tag/);
  assert.match(release, /GitHub Release/);
  assert.equal(d.sections.length, 4);

  const raw = JSON.parse(readFileSync(join(ROOT, 'desk-guides.config.json'), 'utf8'));
  raw.release.sections[1].items = ['1. Version bump', '2. CHANGELOG entry', '3. Push', '4. Done'];
  assert.throws(() => buildD(loadConfig(JSON.stringify(raw))), /must name the annotated tag and the GitHub Release/);
});

test('missing B, D or E policy is fatal rather than rendered as empty space', () => {
  // Mutation killed: the renderer converts a missing section into an empty array
  // and prints a page with a heading over nothing.
  const raw = () => JSON.parse(readFileSync(join(ROOT, 'desk-guides.config.json'), 'utf8'));
  const withWorkflow = raw(); withWorkflow.workflow.callouts = [];
  assert.throws(() => buildB(loadConfig(JSON.stringify(withWorkflow))), /workflow\.callouts/);
  const withDest = raw(); withDest.destinations.rows = [];
  assert.throws(() => buildE(loadConfig(JSON.stringify(withDest))), /destination policy is incomplete/);
});

// ---------------------------------------------------------------------------
// Task 2.2 -- deterministic, scoped HTML
// ---------------------------------------------------------------------------

const renderAll = () => buildPages({ config: frozenConfig(), inventory: INVENTORY })
  .map((model) => ({ model, html: renderPage(model, { layout: CONFIG.layout, meta: META }) }));

test('frozen models and metadata produce byte-identical HTML on repeated runs', () => {
  // Mutation killed: a timestamp, an absolute path, or an unstable object order
  // enters the output. Byte equality, because a structural comparison accepts all
  // three.
  const first = renderAll().map((p) => p.html).join('\0');
  const second = renderAll().map((p) => p.html).join('\0');
  assert.equal(first, second);
  assert.equal(/\d{2}:\d{2}:\d{2}/.test(first), false, 'a wall-clock time reached the page');
  assert.equal(/[A-Za-z]:\\\\|\/home\/|\/Users\//.test(first), false, 'a machine path reached the page');
});

test('every page declares Letter landscape with zero print margins', () => {
  // Mutation killed: the @page block is dropped and the browser's default paper
  // decides the geometry. A page that measures 11x8.5 on screen still prints
  // portrait letter with 0.4in of browser margin without this.
  for (const { model, html } of renderAll()) {
    assert.match(html, /@page \{ size: letter landscape; margin: 0; \}/, `${model.id} has no @page rule`);
    assert.match(html, /width: 11in;/);
    assert.match(html, /height: 8\.5in;/);
  }
});

test('the emitted CSS holds every text role to its configured floor', () => {
  // Mutation killed: one role is reduced to make a page fit. Parsed from the
  // generator's own declarations rather than searched for as a string, so a
  // `12pt` appearing anywhere else cannot satisfy it.
  // Compared against the LAYOUT numbers, never against roleContract(): the
  // contract helper is what emits the CSS, so asserting one against the other
  // moves both sides together and passes for any value at all. Caught by
  // mutation -- reducing `primary` to 9.5pt left this test green.
  const { layout } = CONFIG;
  const css = sharedCss(layout);
  const expected = {
    title: layout.titlePt,
    heading: layout.headingPt,
    primary: layout.bodyPt,
    secondary: layout.minBodyPt,
    footer: layout.minFooterPt,
  };
  for (const [role, sizePt] of Object.entries(expected)) {
    const rule = css.match(new RegExp(`\\[data-dg-role="${role}"\\] \\{ font-size: ([\\d.]+)pt; line-height: ([\\d.]+); \\}`));
    assert.ok(rule, `no emitted rule for role ${role}`);
    assert.equal(Number(rule[1]), sizePt, `${role} does not emit its configured size`);
    assert.ok(Number(rule[2]) >= layout.minLineHeight, `${role} line-height is below the floor`);
  }
  // The type contract's own floors, independent of what the config happens to say.
  assert.ok(expected.title >= 26 && expected.title <= 30, 'title is outside 26-30pt');
  assert.ok(expected.heading >= 17 && expected.heading <= 20, 'section heading is outside 17-20pt');
  assert.ok(expected.primary >= 13, 'primary body is below 13pt');
  assert.ok(expected.secondary >= 12, 'secondary body is below 12pt');
  assert.ok(expected.footer >= 9.5, 'footer is below 9.5pt');
  assert.equal(/condensed|narrow/i.test(css), false, 'a condensed face is named in the stack');
});

test('every page-specific selector is rooted beneath its own page identifier', () => {
  // Mutation killed: a page rule is emitted unscoped, so B's tightened table
  // padding silently reformats D inside the bundle. This is the exact collision
  // that kept the hand-maintained set from ever having a bundle.
  const bundle = renderBundle(buildPages({ config: frozenConfig(), inventory: INVENTORY }), { layout: CONFIG.layout, meta: META });
  const css = bundle.slice(bundle.indexOf('<style>'), bundle.indexOf('</style>'));
  const pageSection = css.slice(css.indexOf('#page-A1'));
  for (const line of pageSection.split('\n')) {
    if (!line.includes('{') || line.trim().startsWith('/*') || line.trim().startsWith('*')) continue;
    assert.match(line.trim(), /^#page-(A1|A2|B|C|D|E)\b/, `unscoped page rule: ${line.trim()}`);
  }
});

test('the bundle carries all six pages in A1 A2 B C D E order', () => {
  // Mutation killed: directory listing or object iteration decides the order.
  const models = buildPages({ config: frozenConfig(), inventory: INVENTORY });
  const bundle = renderBundle(models, { layout: CONFIG.layout, meta: META });
  const order = [...bundle.matchAll(/data-dg-page="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['A1', 'A2', 'B', 'C', 'D', 'E']);
});

test('the bundle body of a page is byte-identical to its standalone body', () => {
  // Mutation killed: the bundle maintains a second copy of the six pages. Two
  // copies is the maintenance burden the spec refused, and byte equality is the
  // only assertion that catches them diverging by one word.
  const models = buildPages({ config: frozenConfig(), inventory: INVENTORY });
  const bundle = renderBundle(models, { layout: CONFIG.layout, meta: META });
  for (const model of models) {
    const body = renderPageBody(model, META, CONFIG.layout);
    assert.ok(bundle.includes(body), `${model.id}'s bundle body differs from its standalone body`);
  }
});

test('an html-only staging set is six pages plus a bundle, and no PDF or PNG', () => {
  // Mutation killed: `--html-only` is implemented as "run everything, then omit
  // the PDF copies", which still requires Poppler and still fails without it --
  // the opposite of the escape hatch it is meant to be.
  const dir = makeRepo({});
  const models = buildPages({ config: frozenConfig(), inventory: INVENTORY });
  for (const model of models) {
    writeFileSync(join(dir, `${PAGE_FILES[model.id]}.html`), renderPage(model, { layout: CONFIG.layout, meta: META }), 'utf8');
  }
  writeFileSync(join(dir, 'desk-guides.html'), renderBundle(models, { layout: CONFIG.layout, meta: META }), 'utf8');
  const files = readdirSync(dir).sort();
  assert.equal(files.length, 7);
  assert.equal(files.filter((f) => f.endsWith('.html')).length, 7);
  assert.deepEqual(files.filter((f) => /\.(pdf|png)$/.test(f)), []);
});

// ---------------------------------------------------------------------------
// Task 2.3 -- browser discovery and measurement
// ---------------------------------------------------------------------------

test('Windows prefers Edge over Chrome, and the order is not incidental', () => {
  // Mutation killed: the candidate order is reversed. Edge is present on every
  // supported Windows install and Chrome is not, and the six pages were fitted
  // and printed from Edge.
  const win = browserCandidates('win32', { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86' });
  const firstEdge = win.findIndex((p) => /msedge/i.test(p));
  const firstChrome = win.findIndex((p) => /chrome/i.test(p));
  assert.notEqual(firstEdge, -1);
  assert.notEqual(firstChrome, -1);
  assert.ok(firstEdge < firstChrome, 'Chrome is tried before Edge on Windows');
});

test('no browser fails with platform instructions and installs nothing', () => {
  // Mutation killed: discovery returns an empty result (so validation is skipped
  // and a page nobody measured is promoted), or it shells out to a package
  // manager. The design forbids the second outright.
  assert.throws(
    () => findBrowser({ platform: 'linux', env: {}, exists: () => false, run: () => ({ stdout: '' }) }),
    (err) => {
      // "usable", since #252: a candidate can now be rejected for answering
      // nothing as well as for being absent, and the headline covers both.
      assert.match(err.message, /no usable Chromium-family browser found/);
      assert.match(err.message, /microsoft-edge-stable|google-chrome-stable|chromium/);
      return true;
    },
  );
});

test('the browser is invoked with an argument array and no shell', () => {
  // Mutation killed: the command is joined into a shell string, which re-parses a
  // path containing a space -- `C:\Program Files (x86)\...` is the default install
  // location, so this breaks on the ordinary case rather than an exotic one.
  const seen = [];
  const run = (command, args) => {
    seen.push({ command, args });
    return { stdout: `<html data-${SENTINEL}><body><div id="dg-findings" hidden></div></body></html>`, status: 0 };
  };
  assert.throws(
    () => measure({ browserPath: 'C:\\Program Files (x86)\\Edge\\msedge.exe', filePath: join(ROOT, 'package.json'), contract: {}, layout: CONFIG.layout, run }),
    /could not be decoded|not a list/,
  );
  assert.equal(seen.length, 1);
  assert.equal(Array.isArray(seen[0].args), true);
  assert.equal(seen[0].command, 'C:\\Program Files (x86)\\Edge\\msedge.exe');
  assert.ok(seen[0].args.every((a) => typeof a === 'string'));
  assert.ok(seen[0].args.includes('--dump-dom'));
  assert.ok(seen[0].args.at(-1).startsWith('file:///'));
});

test('a truncated dump or malformed findings fail closed, never as CLEAN', () => {
  // Mutation killed: a crash or a truncated dump is read as "no findings", which
  // is the same shape as "no problems". This is the single most dangerous
  // possible bug in a layout gate.
  const layout = CONFIG.layout;
  const file = join(ROOT, 'package.json');
  assert.throws(
    () => measure({ browserPath: 'x', filePath: file, contract: {}, layout, run: () => ({ stdout: '<html><body>half a pa', status: 0 }) }),
    /no completion sentinel/,
  );
  assert.throws(
    () => measure({ browserPath: 'x', filePath: file, contract: {}, layout, run: () => ({ stdout: `<html data-${SENTINEL}></html>`, status: 0 }) }),
    /emitted no findings element/,
  );
  assert.throws(
    () => measure({ browserPath: 'x', filePath: file, contract: {}, layout, run: () => ({ stdout: `<html data-${SENTINEL}><div id="dg-findings" hidden>bm90anNvbg==</div></html>`, status: 0 }) }),
    /could not be decoded|not a list/,
  );
});

// ---------------------------------------------------------------------------
// #252 (FORGE-324) -- the browser is chosen by capability, never by existence
// ---------------------------------------------------------------------------

const WIN_ENV = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86' };
const WIN_EDGE = 'C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe';
const WIN_CHROME = 'C:\\PF\\Google\\Chrome\\Application\\chrome.exe';
const PROBE_DUMP = `<html><head></head><body><p id="${PROBE_SENTINEL}">ok</p></body></html>`;

/** A `run` stub keyed by browser path. Anything unlisted answers nothing, which
 *  is exactly what Edge 152 does -- exit 0, zero bytes, for every invocation. */
function browserStub(byPath) {
  const calls = [];
  const run = (command) => {
    calls.push(command);
    return { stdout: byPath[command] ?? '', stderr: '', status: 0 };
  };
  return { run, calls };
}

test('a candidate that exists but answers nothing is skipped for one that answers', () => {
  // Mutation killed: discovery selects on existence alone. Edge 152 exists, exits
  // 0 and writes zero bytes, so the gate chose the one browser on the machine
  // that cannot measure anything -- and then blamed the page for the silence.
  const { run, calls } = browserStub({ [WIN_CHROME]: PROBE_DUMP });
  const warned = [];
  const chosen = findBrowser({
    platform: 'win32',
    env: WIN_ENV,
    exists: (p) => p === WIN_EDGE || p === WIN_CHROME,
    run,
    warn: (message) => warned.push(message),
  });
  assert.equal(chosen, WIN_CHROME);
  assert.deepEqual(calls, [WIN_EDGE, WIN_CHROME], 'the preferred candidate was not probed first');
  // The fall-through is not allowed to be silent: the shipped pages were fitted
  // on Edge, so a run that reaches Chrome measures them on a different engine.
  assert.ok(warned.join('\n').includes(WIN_EDGE), 'the silent browser is not named');
  assert.ok(warned.join('\n').includes(WIN_CHROME), 'the substitute engine is not named');
});

test('a working preferred candidate is chosen in silence, with no fall-through notice', () => {
  // Mutation killed: the re-baselining notice prints on every run. A warning that
  // appears when nothing happened is a warning people learn to scroll past, and
  // this one has to be readable on the day it means something.
  const { run, calls } = browserStub({ [WIN_EDGE]: PROBE_DUMP, [WIN_CHROME]: PROBE_DUMP });
  const warned = [];
  const chosen = findBrowser({
    platform: 'win32',
    env: WIN_ENV,
    exists: () => true,
    run,
    warn: (message) => warned.push(message),
  });
  assert.equal(chosen, WIN_EDGE);
  assert.deepEqual(calls, [WIN_EDGE]);
  assert.deepEqual(warned, []);
});

test('no candidate answering refuses with a reason per candidate, absent or silent', () => {
  // Mutation killed: "Edge is installed and silent" and "Edge is not installed"
  // print the same message. They are different problems with different fixes, and
  // the second one's advice -- install Edge -- is useless to someone who has it.
  const { run } = browserStub({});
  assert.throws(
    () => findBrowser({
      platform: 'win32', env: WIN_ENV, exists: (p) => p === WIN_EDGE, run, warn: () => {},
    }),
    (err) => {
      assert.equal(err.name, 'BrowserError');
      assert.ok(err.message.includes(`${WIN_EDGE} -- present but produced no output`));
      assert.ok(err.message.includes(`${WIN_CHROME} -- absent`));
      assert.match(err.message, /DAFTPLATE_BROWSER/);
      return true;
    },
  );
});

test('each candidate is probed once per process, not once per lookup', () => {
  // Mutation killed: the probe runs on every call. Discovery is a browser launch
  // now, and `findBrowser()` is called once per build and once per test module.
  const { run, calls } = browserStub({ [WIN_CHROME]: PROBE_DUMP });
  const cache = new Map();
  const args = {
    platform: 'win32',
    env: WIN_ENV,
    exists: (p) => p === WIN_EDGE || p === WIN_CHROME,
    run,
    cache,
    warn: () => {},
  };
  assert.equal(findBrowser(args), WIN_CHROME);
  assert.equal(findBrowser(args), WIN_CHROME);
  assert.deepEqual(calls, [WIN_EDGE, WIN_CHROME]);
});

test('DAFTPLATE_BROWSER is honoured, and an unusable pin refuses instead of falling through', () => {
  // Mutation killed: the override is trusted without a probe -- and then fails at
  // measurement, reported as a page fault -- or a bad override falls through to
  // another engine, which is the one thing pinning an engine exists to prevent.
  const PIN = 'D:\\chromium\\chrome.exe';
  const env = { ...WIN_ENV, DAFTPLATE_BROWSER: PIN };
  const good = browserStub({ [PIN]: PROBE_DUMP });
  assert.equal(
    findBrowser({ platform: 'win32', env, exists: () => true, run: good.run, warn: () => {} }),
    PIN,
  );

  const silent = browserStub({ [WIN_EDGE]: PROBE_DUMP, [WIN_CHROME]: PROBE_DUMP });
  assert.throws(
    () => findBrowser({ platform: 'win32', env, exists: () => true, run: silent.run, warn: () => {} }),
    (err) => {
      assert.match(err.message, /DAFTPLATE_BROWSER/);
      assert.ok(err.message.includes(PIN));
      return true;
    },
  );
  assert.deepEqual(silent.calls, [PIN], 'a refused pin fell through to another engine anyway');

  assert.throws(
    () => findBrowser({ platform: 'win32', env, exists: () => false, run: silent.run, warn: () => {} }),
    /does not exist/,
  );
});

test('the probe removes the staging directory it created, and only that one', () => {
  // Mutation killed: the probe leaves a profile directory per candidate per run,
  // or it cleans by pattern and takes a sibling with it. CLAUDE.md constraint 5.
  const root = makeRepo({});
  writeFileSync(join(root, 'not-mine.txt'), 'x', 'utf8');
  const { run } = browserStub({});
  assert.equal(probeBrowser('msedge.exe', { run, tmpRoot: root }), false);
  assert.equal(probeBrowser('chrome.exe', { run: browserStub({ 'chrome.exe': PROBE_DUMP }).run, tmpRoot: root }), true);
  assert.deepEqual(readdirSync(root), ['not-mine.txt']);
});

test('an empty dump accuses the browser; a dump missing the sentinel accuses the page', () => {
  // Mutation killed: both reach one `fail()`. Edge 152 writes zero bytes and the
  // run then reported "the page crashed" about a page that was never loaded,
  // which reads as a broken working tree rather than as a broken browser.
  const layout = CONFIG.layout;
  const file = join(ROOT, 'package.json');
  assert.throws(
    () => measure({
      browserPath: 'msedge.exe', filePath: file, contract: {}, layout,
      run: () => ({ stdout: '', stderr: '', status: 0 }),
    }),
    (err) => {
      assert.match(err.message, /produced no output at all/);
      assert.ok(err.message.includes('msedge.exe'), 'the refusal does not name the browser');
      assert.doesNotMatch(err.message, /the page crashed/);
      return true;
    },
  );
  assert.throws(
    () => measure({
      browserPath: 'msedge.exe', filePath: file, contract: {}, layout,
      run: () => ({ stdout: '<html><body>half a pa', stderr: '', status: 0 }),
    }),
    /no completion sentinel/,
  );
});

// --- real-browser measurement ----------------------------------------------
// These need an actual Chromium-family browser. Skipped rather than faked where
// none exists: a fixture that simulates the DOM would be measuring the fixture.

let BROWSER = null;
try { BROWSER = findBrowser(); } catch { BROWSER = null; }
const inBrowser = BROWSER ? test : test.skip;

const LAYOUT = { ...CONFIG.layout, maxLines: { ...CONFIG.layout.maxLines, T: 2 } };
const CONTRACT = typeContract(LAYOUT);

/** A minimal page carrying the shared print contract, so computed style in the
 *  fixture is the computed style the real pages get. */
function fixturePage(body, extraCss = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>fixture</title>
<style>
${sharedCss(LAYOUT)}
${extraCss}
</style></head>
<body>
<div class="dg-page" id="page-T" data-dg-page="T">
${body}
</div>
</body></html>
`;
}

function findingsFor(body, extraCss = '') {
  const dir = makeRepo({});
  const htmlPath = join(dir, 'fixture.html');
  const html = fixturePage(body, extraCss);
  writeFileSync(htmlPath, html, 'utf8');
  return validatePage({
    browserPath: BROWSER,
    htmlPath,
    html,
    probePath: join(dir, 'fixture.probe.html'),
    contract: CONTRACT,
    layout: LAYOUT,
    // A profile directory of this test's own, for the reason `browser.mjs:86-89`
    // documents: without one a launch can attach to a browser still shutting down
    // from the previous case and exit with no output. That arrives as "no
    // completion sentinel" and is a second, independent source of #252's symptom.
    userDataDir: join(dir, 'browser'),
  });
}

inBrowser('content that fits exactly passes the documented rounding tolerance', () => {
  // Mutation killed: the comparison uses `>=`, or ignores the rounding allowance
  // entirely. Sub-pixel line-box rounding then makes every page fail, and a gate
  // that always fails is a gate that gets switched off.
  const findings = findingsFor(`<div class="dg-card" style="height: 120px;">
    <p ${'data-dg-role="primary"'} data-dg-lines="2">One short line.</p>
  </div>`);
  assert.deepEqual(findings.filter((f) => f.type === 'overflow'), []);
  assert.deepEqual(findings.filter((f) => f.type === 'lineCount'), []);
});

inBrowser('a description that overflows its clipping box is reported with the amount', () => {
  // Mutation killed: scroll-dimension collection is removed. Text then vanishes
  // off the bottom of a card on paper with nothing said about it.
  const findings = findingsFor(`<div class="dg-card" data-dg-id="tight" style="height: 40px;">
    <p data-dg-role="primary">${'A description long enough to wrap several times. '.repeat(6)}</p>
  </div>`);
  const overflow = findings.filter((f) => f.type === 'overflow');
  assert.ok(overflow.length >= 1, 'no overflow finding for content that plainly does not fit');
  assert.match(overflow[0].message, /clipped by its own box/);
  assert.ok(Number(String(overflow[0].actual).match(/y(\d+)/)[1]) > 10);
});

inBrowser('twelve measured lines fail a seven-line budget in a 145px card', () => {
  // Mutation killed: the count comes from a configured estimate or from newline
  // characters. This is the measured failure from the original build -- copy
  // expected to occupy seven lines reached twelve, and all eight cards overflowed
  // their 145px boxes. Neither an estimate nor a `\\n` count can see it.
  const findings = findingsFor(`<div class="dg-card" style="height: 145px; width: 2in; overflow: visible;">
    <p data-dg-role="secondary" data-dg-lines="7" data-dg-id="twelve">${'word '.repeat(60)}</p>
  </div>`);
  const lineCount = findings.filter((f) => f.type === 'lineCount' && f.id === 'twelve');
  assert.equal(lineCount.length, 1);
  assert.ok(lineCount[0].actual >= 12, `expected at least 12 measured lines, got ${lineCount[0].actual}`);
  assert.equal(lineCount[0].expected, 7);
});

inBrowser('all eight 145px cards fail, not just the first one measured', () => {
  // The measured failure from the original build, frozen at its real scale:
  // descriptions expected to occupy seven lines reached twelve, and ALL EIGHT
  // cards overflowed their 145px boxes.
  //
  // Mutation killed: the validator returns on the first finding, or measures only
  // the first element of a repeated structure. Eight identical cards distinguish
  // "found a problem" from "found every instance of it", and only the second is
  // useful when the remedy is per-card editing.
  const card = (n) => `<div class="dg-card" style="height: 145px; width: 2in; overflow: visible;">
    <p data-dg-role="secondary" data-dg-lines="7" data-dg-id="card-${n}">${'word '.repeat(60)}</p>
  </div>`;
  const findings = findingsFor([1, 2, 3, 4, 5, 6, 7, 8].map(card).join('\n'));
  const overLimit = findings.filter((f) => f.type === 'lineCount');
  assert.equal(overLimit.length, 8, `only ${overLimit.length} of 8 cards were reported`);
  assert.deepEqual(overLimit.map((f) => f.id).sort(), [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `card-${n}`));
  for (const finding of overLimit) assert.ok(finding.actual >= 12, `${finding.id} measured ${finding.actual} lines`);
});

inBrowser('shortening the copy to the budget passes, and does so at full type size', () => {
  // The prescribed remedy, pinned. Mutation killed: the implementation "fixes"
  // overflow by shrinking type, which passes an overflow check and fails the type
  // contract -- so this asserts the absence of BOTH a line-count finding and a
  // type finding on the same fixture.
  const findings = findingsFor(`<div class="dg-card" style="height: 145px; width: 2in;">
    <p data-dg-role="secondary" data-dg-lines="7" data-dg-id="short">Fewer words, same size.</p>
  </div>`);
  assert.deepEqual(findings.filter((f) => f.type === 'lineCount'), []);
  assert.deepEqual(findings.filter((f) => f.type === 'type'), []);
  assert.deepEqual(findings.filter((f) => f.type === 'lineHeight'), []);
});

test('the bundle and the individual pages present the same page boxes to the validator', () => {
  // Mutation killed: bundle scoping introduces layout differences the individual
  // page tests cannot see -- an unscoped rule, a different page id, a missing
  // stylesheet. Compared as the exact set of measured attributes, because the
  // validator's findings are addressed by `data-dg-page`, `data-dg-role` and
  // `data-dg-id`, and a difference in any of them means the two are not the same
  // page any more.
  const models = buildPages({ config: frozenConfig(), inventory: INVENTORY });
  const bundle = renderBundle(models, { layout: CONFIG.layout, meta: META });
  // Body only: the shared stylesheet contains `[data-dg-role="..."]` selectors,
  // and an individual page carries one copy each while the bundle carries one
  // copy total. That difference is correct and is not a markup difference.
  const marks = (html) => (html.slice(html.indexOf('<body>'))
    .match(/data-dg-(page|role|id|lines)="[^"]*"/g) ?? []).sort();

  const fromIndividuals = models
    .flatMap((model) => marks(renderPage(model, { layout: CONFIG.layout, meta: META })))
    .sort();
  assert.deepEqual(marks(bundle), fromIndividuals);
  // And the six page roots are present exactly once each.
  assert.deepEqual(
    (bundle.match(/data-dg-page="[^"]*"/g) ?? []),
    ['A1', 'A2', 'B', 'C', 'D', 'E'].map((id) => `data-dg-page="${id}"`),
  );
});

inBrowser('secondary text computing below the 12pt floor fails, measured not declared', () => {
  // Mutation killed: the validator trusts the source CSS token instead of the
  // computed style. An inherited `font-size: 0.8em` produces 9.6pt from a
  // stylesheet whose every literal says 12pt.
  const findings = findingsFor(`<div class="dg-card" style="font-size: 0.8em;">
    <p data-dg-role="secondary" data-dg-id="small" style="font-size: 0.8em;">Too small to read at three feet.</p>
  </div>`);
  const type = findings.filter((f) => f.type === 'type' && f.id === 'small');
  assert.equal(type.length, 1);
  assert.ok(type[0].actual < CONFIG.layout.minBodyPt);
});

inBrowser('an opaque negative-margin neighbour over page B text fails while overflow stays clean', () => {
  // The regression this whole module exists for, reproduced rather than described.
  // Page B's core-loop strip rendered "Orient" as "Orien" and "worktree" as
  // "worktre" because each cell carried an opaque background, z-index 1 and a
  // negative margin. `scrollWidth === clientWidth` throughout.
  //
  // Mutation killed: occlusion is implemented as another scroll-dimension check.
  // BOTH halves are asserted -- overflow empty, occlusion present -- because the
  // finding that matters is the one a clean overflow report hides.
  const findings = findingsFor(`<div class="dg-loop">
    <div class="dg-step" data-dg-role="primary" data-dg-id="loop-0">Orient</div>
    <div class="dg-step dg-over" data-dg-role="primary" data-dg-id="loop-1">issue/spec</div>
  </div>`, `
.dg-loop { display: flex; }
.dg-step { border: 1pt solid #111; padding: 4px 8px; background: #ffffff; }
.dg-over { position: relative; z-index: 1; margin-left: -46px; }
`);
  assert.deepEqual(findings.filter((f) => f.type === 'overflow'), [],
    'the fixture must reproduce the ORIGINAL condition: no overflow reported');
  const occlusion = findings.filter((f) => f.type === 'occlusion');
  assert.equal(occlusion.length, 1);
  assert.equal(occlusion[0].id, 'loop-0');
  assert.match(occlusion[0].text, /Orient/);
  assert.equal(occlusion[0].occludedBy, 'loop-1');
});

inBrowser('two text boxes sharing a rectangle fail even when neither has a background', () => {
  // Found by looking at a page this gate had just called clean. Page B's B3 table
  // printed across the footer's provenance line: the table fitted its own card,
  // the card fitted the page, nothing was clipped, and no opaque box painted over
  // anything -- two transparent runs of text simply occupied the same rectangle.
  //
  // Mutation killed: collision is folded into the occlusion rule, which requires
  // an opaque painter and therefore cannot see this at all. Both halves are
  // asserted -- overflow empty, collision present -- because the whole point is
  // that the other rules report clean.
  const findings = findingsFor(`<div style="position: relative; height: 200px;">
    <p data-dg-role="primary" data-dg-id="under" style="position: absolute; top: 40px; left: 0; width: 4in;">The provenance line nobody can read.</p>
    <p data-dg-role="primary" data-dg-id="over" style="position: absolute; top: 44px; left: 0; width: 4in;">The table row printed across it.</p>
  </div>`);
  assert.deepEqual(findings.filter((f) => f.type === 'overflow'), [],
    'the fixture must reproduce the original condition: nothing is clipped');
  assert.deepEqual(findings.filter((f) => f.type === 'occlusion'), [],
    'the fixture must reproduce the original condition: no opaque painter');
  const collisions = findings.filter((f) => f.type === 'collision');
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].id, 'under');
  assert.equal(collisions[0].occludedBy, 'over');
  assert.match(collisions[0].text, /provenance line/);
});

inBrowser('transparent and non-painting overlap is not reported as lost ink', () => {
  // Mutation killed: every geometric intersection is treated as occlusion. Nested
  // layout overlaps constantly, so this mutant reports on every card of every
  // page -- and a finding list nobody can act on is the same as no gate at all.
  const findings = findingsFor(`<div class="dg-card" style="position: relative;">
    <p data-dg-role="primary" data-dg-id="under">Readable text that nothing paints over.</p>
    <div data-dg-id="ghost" style="position: absolute; inset: 0; background: transparent;"></div>
    <div data-dg-id="hidden-box" style="position: absolute; inset: 0; background: #fff; visibility: hidden;"></div>
  </div>`);
  assert.deepEqual(findings.filter((f) => f.type === 'occlusion'), []);
  assert.deepEqual(findings.filter((f) => f.type === 'probe'), []);
});

// ---------------------------------------------------------------------------
// Additive, not a regression: pins the escaping contract the templates rely on.
// ---------------------------------------------------------------------------

test('source text is escaped into the page as data, never as markup', () => {
  assert.equal(esc('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  const config = frozenConfig({
    selected: [
      { key: 'claude:orient', page: 'A1', group: 'start', summary: 'Use <b>when</b> starting & steering.' },
      { key: 'claude:brief', page: 'A1', group: 'start', summary: 'Use when terse.' },
    ],
  });
  const html = renderPage(buildA1(config, INVENTORY), { layout: CONFIG.layout, meta: META });
  assert.ok(html.includes('Use &lt;b&gt;when&lt;/b&gt; starting &amp; steering.'));
  assert.equal(html.includes('Use <b>when</b> starting'), false);
});
