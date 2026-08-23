import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDir } from './helpers/make-repo.mjs';
import { scaffold } from '../scripts/scaffold.mjs';
import { PROVENANCE_FILE, readProvenance } from '../scripts/lib/provenance.mjs';

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
