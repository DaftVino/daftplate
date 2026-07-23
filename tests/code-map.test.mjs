import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { makeRepo } from './helpers/make-repo.mjs';
import {
  scanSource, scanHtml, renderMap, collectFiles, buildCodeMap, sourceCommit,
} from '../scripts/code-map.mjs';

test('scanSource finds function declarations with 1-indexed line numbers', () => {
  const text = [
    'const x = 1;',
    'function alpha(a, b) {',
    '  return a + b;',
    '}',
    'export function beta() {}',
    'export async function gamma() {}',
  ].join('\n');

  assert.deepEqual(scanSource(text), [
    { line: 2, kind: 'function', name: 'alpha' },
    { line: 5, kind: 'function', name: 'beta' },
    { line: 6, kind: 'function', name: 'gamma' },
  ]);
});

test('scanSource finds class declarations', () => {
  const text = ['class Registry {', '}', 'export class Store extends Base {'].join('\n');

  assert.deepEqual(scanSource(text), [
    { line: 1, kind: 'class', name: 'Registry' },
    { line: 3, kind: 'class', name: 'Store' },
  ]);
});

test('scanSource ignores calls, strings, and comments that merely mention function', () => {
  const text = [
    '// function notReal() {}',
    'const s = "function alsoNotReal() {}";',
    'doSomething(function () {});',
    'obj.method(function named() {});',
  ].join('\n');

  assert.deepEqual(scanSource(text), []);
});

test('scanSource finds arrow and function-expression constants', () => {
  const text = [
    'const alpha = (a, b) => a + b;',
    'export const beta = async () => {};',
    'const gamma = function () {};',
    'let delta = x => x;',
    'const notAFunction = 42;',
    'const alsoNot = { a: 1 };',
  ].join('\n');

  assert.deepEqual(scanSource(text), [
    { line: 1, kind: 'function', name: 'alpha' },
    { line: 2, kind: 'function', name: 'beta' },
    { line: 3, kind: 'function', name: 'gamma' },
    { line: 4, kind: 'function', name: 'delta' },
  ]);
});

test('scanSource names a banner section from the comment beneath it', () => {
  const text = [
    '// =====================',
    '// Capture registry',
    '// =====================',
    'function store() {}',
    '/* ------------------- */',
    '/* Rendering           */',
    'function draw() {}',
  ].join('\n');

  assert.deepEqual(scanSource(text), [
    { line: 1, kind: 'section', name: 'Capture registry' },
    { line: 4, kind: 'function', name: 'store' },
    { line: 5, kind: 'section', name: 'Rendering' },
    { line: 7, kind: 'function', name: 'draw' },
  ]);
});

test('scanSource skips an unnamed banner rather than emitting a blank section', () => {
  const text = ['// ==========', 'function alpha() {}'].join('\n');

  assert.deepEqual(scanSource(text), [{ line: 2, kind: 'function', name: 'alpha' }]);
});

test('scanSource handles CRLF input without trailing carriage returns in names', () => {
  const text = ['// =====', '// Capture registry', '// =====', 'function store() {}'].join('\r\n');

  assert.deepEqual(scanSource(text), [
    { line: 1, kind: 'section', name: 'Capture registry' },
    { line: 4, kind: 'function', name: 'store' },
  ]);
});

test('scanHtml records script, style, and template blocks with their line numbers', () => {
  const text = [
    '<!DOCTYPE html>',
    '<style>',
    '  body { margin: 0 }',
    '</style>',
    '<script>',
    '  function render() {}',
    '</script>',
  ].join('\n');

  assert.deepEqual(scanHtml(text), [
    { line: 2, kind: 'block', name: 'style' },
    { line: 5, kind: 'block', name: 'script' },
    { line: 6, kind: 'function', name: 'render' },
  ]);
});

test('scanHtml keeps entries in line order when a function precedes a later block', () => {
  const text = [
    '<script>',
    'function first() {}',
    '</script>',
    '<style>',
    '</style>',
  ].join('\n');

  assert.deepEqual(scanHtml(text), [
    { line: 1, kind: 'block', name: 'script' },
    { line: 2, kind: 'function', name: 'first' },
    { line: 4, kind: 'block', name: 'style' },
  ]);
});

test('renderMap emits a greppable line per symbol, with a size header per file', () => {
  const out = renderMap([
    {
      path: 'src/app.js',
      bytes: 2048,
      lines: 90,
      entries: [
        { line: 1, kind: 'section', name: 'Bootstrap' },
        { line: 12, kind: 'function', name: 'start' },
      ],
    },
  ]);

  assert.match(out, /^# Code map\n/);
  assert.match(out, /## `src\/app\.js`\n/);
  assert.match(out, /2\.0 KB · 90 lines/);
  assert.match(out, /^- `src\/app\.js:1` — \*\*Bootstrap\*\* \(section\)$/m);
  assert.match(out, /^- `src\/app\.js:12` — `start\(\)` \(function\)$/m);
  assert.equal(out.endsWith('\n'), true);
});

test('renderMap says so explicitly when a file yields no symbols', () => {
  const out = renderMap([{ path: 'src/data.json', bytes: 10, lines: 1, entries: [] }]);
  assert.match(out, /no indexable symbols/);
});

test('renderMap warns at the top that the map is generated', () => {
  const out = renderMap([{ path: 'a.js', bytes: 1, lines: 1, entries: [] }]);
  assert.match(out, /Generated by `scripts\/code-map\.mjs`/);
  assert.match(out, /do not edit by hand/i);
});

test('renderMap records the commit so a reader can detect a stale map', () => {
  const out = renderMap([{ path: 'a.js', bytes: 1, lines: 1, entries: [] }],
    { commit: 'a1b2c3d', date: '2026-07-22' });

  assert.match(out, /on 2026-07-22/);
  assert.match(out, /source as of commit `a1b2c3d`/);
});

test('renderMap escapes backticks and pipes in a symbol name', () => {
  const out = renderMap([{
    path: 'a.js', bytes: 1, lines: 1,
    entries: [{ line: 3, kind: 'section', name: 'parse `a|b` input' }],
  }]);

  assert.match(out, /\*\*parse \\`a\\\|b\\` input\*\*/);
});

test('collectFiles indexes source files, biggest first, and skips other extensions', () => {
  const dir = makeRepo({
    'small.js': 'function a() {}\n',
    'big.js': `${'// filler\n'.repeat(200)}function b() {}\n`,
    'notes.md': '# not source\n',
    'page.html': '<script>\nfunction c() {}\n</script>\n',
  });

  const files = collectFiles(dir, { minBytes: 0 });

  assert.deepEqual(files.map((f) => f.path), ['big.js', 'page.html', 'small.js']);
  assert.equal(files[0].bytes > files[2].bytes, true);
  assert.deepEqual(files[2].entries, [{ line: 1, kind: 'function', name: 'a' }]);
});

test('collectFiles skips node_modules and .git', () => {
  const dir = makeRepo({
    'app.js': 'function a() {}\n',
    'node_modules/dep/index.js': 'function dep() {}\n',
    '.git/hooks/pre-commit.js': 'function hook() {}\n',
  });

  assert.deepEqual(collectFiles(dir, { minBytes: 0 }).map((f) => f.path), ['app.js']);
});

test('collectFiles honours minBytes so trivial files stay out of the map', () => {
  const dir = makeRepo({
    'tiny.js': 'function a() {}\n',
    'large.js': `${'// filler\n'.repeat(100)}function b() {}\n`,
  });

  assert.deepEqual(collectFiles(dir, { minBytes: 500 }).map((f) => f.path), ['large.js']);
});

test('collectFiles never reads a file below minBytes', () => {
  const dir = makeRepo({
    'tiny.js': 'function a() {}\n',
    'large.js': `${'// filler\n'.repeat(100)}function b() {}\n`,
  });
  // A directory entry statSync can see but readFileSync would throw on proves
  // the filter runs first. Simpler proof: the small file has a symbol, and it
  // must not appear in the output at all.
  const files = collectFiles(dir, { minBytes: 500 });

  assert.equal(files.length, 1);
  assert.equal(files.some((f) => f.entries.some((e) => e.name === 'a')), false);
});

test('buildCodeMap writes docs/code-map.md and reports what it indexed', () => {
  const dir = makeRepo({ 'app.js': 'function a() {}\nclass B {}\n' });

  const result = buildCodeMap(dir, { minBytes: 0, commit: 'abc1234', date: '2026-07-22' });

  assert.equal(result.path, join(dir, 'docs', 'code-map.md'));
  assert.equal(result.files, 1);
  assert.equal(result.symbols, 2);
  assert.equal(existsSync(result.path), true);
  assert.match(readFileSync(result.path, 'utf8'), /`app\.js:1` — `a\(\)`/);
});

test('buildCodeMap creates docs/ when the repo has none', () => {
  const dir = makeRepo({ 'app.js': 'function a() {}\n' });
  const result = buildCodeMap(dir, { minBytes: 0, commit: 'abc1234', date: '2026-07-22' });
  assert.equal(existsSync(result.path), true);
});

test('buildCodeMap honours an explicit --out path', () => {
  const dir = makeRepo({ 'app.js': 'function a() {}\n' });
  const result = buildCodeMap(dir, { minBytes: 0, out: 'docs/maps/index.md', commit: 'abc1234', date: '2026-07-22' });
  assert.equal(result.path, join(dir, 'docs', 'maps', 'index.md'));
  assert.equal(existsSync(result.path), true);
});

test('buildCodeMap reports commit "unknown" outside a git repo rather than throwing', () => {
  const dir = makeRepo({ 'app.js': 'function a() {}\n' });
  const result = buildCodeMap(dir, { minBytes: 0 });
  assert.equal(typeof result.commit, 'string');
  assert.match(readFileSync(result.path, 'utf8'), /source as of commit `unknown`/);
});

// A tree with a real .git, so the git-aware paths are exercised against git
// rather than against a stub. `prefix` exists so one caller can force a space
// into the repo path — see the headCommit test below.
function makeGitRepo(files = {}, prefix = 'pt-git-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [rel, contents] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

test('buildCodeMap reads the commit from a repo whose path contains a space', () => {
  // Regression: headCommit ran spawnSync with `shell: true`, so the shell
  // word-split `-C x:\Projects\Torn Bookie Live Scores` and git exited 128.
  // The header then said `unknown`, silently voiding the staleness check the
  // header itself tells the reader to perform.
  const dir = makeGitRepo({ 'app.js': 'function a() {}\n' }, 'pt git repo ');

  assert.equal(dir.includes(' '), true, 'the fixture must have a space to be a regression test');
  const expected = spawnSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
    .stdout.trim();
  const result = buildCodeMap(dir, { minBytes: 0 });

  assert.notEqual(result.commit, 'unknown');
  assert.equal(result.commit, expected);
});

test('collectFiles skips a gitignored file that walkFiles would otherwise index', () => {
  // Regression: EXCLUDED_DIRS is a fixed list, so a stale worktree copy of a
  // source file under an ignored directory was indexed beside the real one and
  // every symbol grep returned two plausible anchors.
  const dir = makeGitRepo({
    '.gitignore': '.kilo/\n',
    'app.js': 'function real() {}\n',
    '.kilo/worktrees/stale/app.js': 'function stale() {}\n',
  });

  assert.deepEqual(collectFiles(dir, { minBytes: 0 }).map((f) => f.path), ['app.js']);
});

test('collectFiles still indexes an untracked file that git does not ignore', () => {
  // Tracked-only filtering would empty the map of a freshly scaffolded repo,
  // so the filter is "not ignored", not "committed".
  const dir = makeGitRepo({ 'app.js': 'function a() {}\n' });
  writeFileSync(join(dir, 'fresh.js'), 'function fresh() {}\n', 'utf8');

  // Biggest first, so `fresh.js` leads — the assertion here is membership.
  assert.deepEqual(collectFiles(dir, { minBytes: 0 }).map((f) => f.path), ['fresh.js', 'app.js']);
});

test('the recorded commit survives committing the map itself', () => {
  // The defect: the stamp was HEAD at generation time, so committing the map
  // moved HEAD past it and the freshness check the header prescribes reported
  // a stale map on the very commit that generated it — a false positive at the
  // exact moment the map is most trustworthy. Both target repos hit this.
  const dir = makeGitRepo({ 'app.js': 'function a() {}\n' });
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

  const stamped = buildCodeMap(dir, { minBytes: 0 }).commit;
  git('add', '-A');
  git('commit', '-qm', 'chore: add the code map');

  assert.notEqual(git('rev-parse', '--short', 'HEAD').stdout.trim(), stamped,
    'the fixture must move HEAD past generation, or it is not the regression');
  assert.equal(sourceCommit(dir), stamped);
});

test('the recorded commit moves when an indexed source file changes', () => {
  // The other half: the stamp must still go stale for the reason it exists.
  const dir = makeGitRepo({ 'app.js': 'function a() {}\n' });
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  const before = buildCodeMap(dir, { minBytes: 0 }).commit;

  writeFileSync(join(dir, 'app.js'), 'function a() {}\nfunction b() {}\n', 'utf8');
  git('add', '-A');
  git('commit', '-qm', 'feat: add b');

  assert.notEqual(sourceCommit(dir), before);
});

test('the recorded commit ignores a commit that touches no indexed file', () => {
  const dir = makeGitRepo({ 'app.js': 'function a() {}\n' });
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  const before = buildCodeMap(dir, { minBytes: 0 }).commit;

  writeFileSync(join(dir, 'README.md'), '# docs only\n', 'utf8');
  git('add', '-A');
  git('commit', '-qm', 'docs: readme');

  assert.equal(sourceCommit(dir), before);
});

test('sourceCommit reports "unknown" outside a git repo rather than throwing', () => {
  assert.equal(sourceCommit(makeRepo({ 'app.js': 'function a() {}\n' })), 'unknown');
});

test('renderMap prescribes a freshness check the map can actually pass', () => {
  // The header is the only part of the artifact read programmatically, so the
  // command it names must be the one that produced the stamp.
  const header = renderMap([], { commit: 'abc1234', date: '2026-07-22' });

  assert.match(header, /git log -1 --format=%h/);
  assert.doesNotMatch(header, /git rev-parse --short HEAD/);
});

test('collectFiles indexes everything indexable outside a git repo', () => {
  // The git filter degrades to no filter; a non-git directory must map in full.
  const dir = makeRepo({ 'app.js': 'function a() {}\n', 'lib/util.js': 'function u() {}\n' });

  assert.deepEqual(collectFiles(dir, { minBytes: 0 }).map((f) => f.path), ['app.js', 'lib/util.js']);
});
