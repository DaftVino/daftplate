import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, emptyDir } from './helpers/make-repo.mjs';
import { resolveNodeVersion, DEFAULT_NODE_VERSION } from '../scripts/resolve-node-version.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'resolve-node-version.mjs');
const pkg = (engines) => makeRepo({ 'package.json': JSON.stringify({ name: 'x', ...engines }) });

test('an exact declared selector is returned unchanged', () => {
  const root = pkg({ engines: { node: '24.4.1' } });
  assert.deepEqual(resolveNodeVersion(root), { version: '24.4.1', source: 'engines' });
});

test('a range is preserved byte-for-byte', () => {
  // Extracting a major, or otherwise normalizing, silently runs a different
  // runtime than the repository asked for. setup-node accepts ranges natively.
  for (const range of ['>=22 <25', '^24.0.0', '>=20', 'lts/hydrogen']) {
    const root = pkg({ engines: { node: range } });
    assert.equal(resolveNodeVersion(root).version, range);
  }
});

test('a missing package.json selects the default rather than failing', () => {
  const resolved = resolveNodeVersion(emptyDir());
  assert.deepEqual(resolved, { version: DEFAULT_NODE_VERSION, source: 'default' });
  // lts/* and not a pinned major: the point is a default that cannot go stale.
  assert.equal(DEFAULT_NODE_VERSION, 'lts/*');
});

test('a package with no engines.node selects the default', () => {
  // Most repos declare nothing. Requiring a declaration would break every one of
  // them to fix a contradiction they do not have.
  assert.equal(resolveNodeVersion(pkg({})).source, 'default');
  assert.equal(resolveNodeVersion(pkg({ engines: {} })).source, 'default');
  assert.equal(resolveNodeVersion(pkg({ engines: { npm: '>=10' } })).source, 'default');
});

test('malformed JSON fails loudly instead of falling back', () => {
  // Silently defaulting here hides a manifest the caller believes in.
  const root = makeRepo({ 'package.json': '{ "name": "x", ' });
  assert.throws(() => resolveNodeVersion(root), /package\.json could not be parsed/);
});

test('a present but non-object engines value fails loudly', () => {
  for (const engines of ['>=24', 42, ['>=24']]) {
    const root = makeRepo({ 'package.json': JSON.stringify({ name: 'x', engines }) });
    assert.throws(() => resolveNodeVersion(root), /engines is present but is not an object/);
  }
});

test('a node value that is not a trimmed, single-line string is rejected', () => {
  // The value reaches $GITHUB_OUTPUT, so a line break would let a declaration
  // append arbitrary output records. Blank and untrimmed are refused rather than
  // repaired: silently trimming means the file says one thing and CI does
  // another, which is the exact class of defect this script exists to close.
  const cases = [
    [{ node: 24 }, /must be a string/],
    [{ node: null }, /must be a string/],
    [{ node: '' }, /non-empty and already trimmed/],
    [{ node: ' >=24' }, /non-empty and already trimmed/],
    [{ node: '>=24 ' }, /non-empty and already trimmed/],
    [{ node: '>=24\nnode-version=evil' }, /must not contain a line break/],
    [{ node: '>=24\rnode-version=evil' }, /must not contain a line break/],
  ];
  for (const [engines, pattern] of cases) {
    const root = makeRepo({ 'package.json': JSON.stringify({ name: 'x', engines }) });
    assert.throws(() => resolveNodeVersion(root), pattern, JSON.stringify(engines));
  }
});

test('the command emits one output record on stdout and the source on stderr', () => {
  // stdout is the machine channel the caller redirects into $GITHUB_OUTPUT.
  // A diagnostic printed there becomes a bogus output record; a fallback that
  // says nothing anywhere is an invisible runtime change.
  const declared = spawnSync(process.execPath, [SCRIPT], {
    cwd: pkg({ engines: { node: '>=22 <25' } }), encoding: 'utf8',
  });
  assert.equal(declared.status, 0);
  assert.equal(declared.stdout, 'node-version=>=22 <25\n');
  assert.match(declared.stderr, /from package\.json engines\.node/);

  const fallback = spawnSync(process.execPath, [SCRIPT], { cwd: emptyDir(), encoding: 'utf8' });
  assert.equal(fallback.status, 0);
  assert.equal(fallback.stdout, 'node-version=lts/*\n');
  assert.match(fallback.stderr, /using the default/);

  // A failure writes no partial record: a half-written $GITHUB_OUTPUT is worse
  // than a failed step, because the workflow carries on with a value nobody set.
  const broken = spawnSync(process.execPath, [SCRIPT], {
    cwd: makeRepo({ 'package.json': '{ oops' }), encoding: 'utf8',
  });
  assert.equal(broken.status, 1);
  assert.equal(broken.stdout, '');
  assert.match(broken.stderr, /package\.json could not be parsed/);
});

test('the root resolver and the shipped template copy are byte-identical', () => {
  // Editing only the dogfooding copy means scaffolded repos keep the old
  // behaviour; editing only the template means this repo does.
  assert.equal(
    readFileSync(SCRIPT, 'utf8'),
    readFileSync(join(ROOT, 'base', 'files', 'scripts', 'resolve-node-version.mjs'), 'utf8'),
  );
});
