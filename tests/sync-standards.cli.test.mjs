import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDir } from './helpers/make-repo.mjs';
import { scaffold } from '../scripts/scaffold.mjs';
import { PROVENANCE_FILE, readProvenance, fileDigest } from '../scripts/lib/provenance.mjs';

// The command, exercised the way an operator runs it. An injected main() proves
// the argv-to-engine mapping and nothing about what gets typed: not that runCli
// fires, not that the exit code reaches the shell, not that refusals go to
// stderr rather than stdout. A subprocess cannot be injected into. Matches
// apply-layer.cli.test.mjs / enroll-repo.cli.test.mjs / publish.cli.test.mjs.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/sync-standards.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

const TOKENS = { PROJECT_NAME: 'cli-fixture', PROJECT_SUMMARY: 'CLI fixture.' };

const scaffolded = () => {
  const target = emptyDir();
  scaffold(ROOT, 'web-app', target, { year: 2026, tokens: TOKENS });
  return target;
};

/** Unwinds README.md back to a NEW offer: removes both the file and its
 *  manifest entry, so the next sync run classifies it NEW / OFFER_ADD and
 *  --decline has something to intercept. */
const withUndeclaredReadme = (target) => {
  const manifestPath = join(target, PROVENANCE_FILE);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete manifest.files['README.md'];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  rmSync(join(target, 'README.md'));
  return target;
};

test('CLI --decline-all exits 2 with the --add-all message shape', () => {
  const target = scaffolded();

  const result = run(ROOT, target, '--decline-all');

  assert.equal(result.status, 2);
  assert.match(result.stderr, /no --decline-all/i);
  assert.match(result.stderr, /naming each path is what makes declining it a decision/i);
});

test('CLI run with --decline= exits 0 and the manifest holds the declined entry', () => {
  const target = withUndeclaredReadme(scaffolded());

  const result = run(ROOT, target, '--decline=README.md');

  assert.equal(result.status, 0);
  assert.match(result.stdout, /DECLINED README\.md/);

  const entry = readProvenance(target).files['README.md'];
  assert.equal(entry.ownership, 'declined');
  assert.equal('digest' in entry, false);
  assert.match(entry.templateDigest, /^sha256:[0-9a-f]{64}$/);
});

/** Rewrites one managed entry's digest to a well-formed value nothing on disk
 *  has, which is the shape a repo is left in when its files are restored from
 *  Git after a bad sync: the bytes are right, the manifest describes bytes that
 *  are no longer there, and every run says REFUSED MODIFIED. */
const withStaleDigest = (target, rel) => {
  const manifestPath = join(target, PROVENANCE_FILE);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files[rel].digest = `sha256:${'0'.repeat(64)}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return target;
};

test('CLI --rebaseline-all exits 2 with the --add-all message shape', () => {
  const target = scaffolded();

  const result = run(ROOT, target, '--rebaseline-all');

  assert.equal(result.status, 2);
  assert.match(result.stderr, /no --rebaseline-all/i);
  assert.match(result.stderr, /naming each path is what makes re-baselining it a decision/i);
});

test('CLI --rebaseline= exits 0, records the on-disk bytes, and writes no file', () => {
  const target = withStaleDigest(scaffolded(), 'README.md');
  const readmeBefore = readFileSync(join(target, 'README.md'), 'utf8');

  assert.match(run(ROOT, target).stdout, /REFUSED MODIFIED README\.md/);

  const result = run(ROOT, target, '--rebaseline=README.md');

  assert.equal(result.status, 0);
  assert.match(result.stdout, /REBASELINED README\.md/);
  assert.match(result.stdout, /re-baselined 1/);
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), readmeBefore);
  assert.equal(readProvenance(target).files['README.md'].digest, fileDigest(join(target, 'README.md')));
});
