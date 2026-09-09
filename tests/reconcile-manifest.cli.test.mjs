import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDir } from './helpers/make-repo.mjs';
import { scaffold } from '../scripts/scaffold.mjs';
import { enrollRepo } from '../scripts/enroll-repo.mjs';
import { PROVENANCE_FILE, readProvenance } from '../scripts/lib/provenance.mjs';

// The command as an operator runs it. An injected main() proves the argv-to-engine
// mapping and nothing about what gets typed: not that runCli fires, not that the
// exit code reaches the shell, not that refusals go to stderr rather than stdout.
// Matches sync-standards.cli.test.mjs / enroll-repo.cli.test.mjs.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/reconcile-manifest.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

const RIGHT = ['--token=YEAR=2026', '--token=PROJECT_NAME=cli-repo',
  '--token=PROJECT_SUMMARY=The right summary.'];

const misenrolled = () => {
  const target = emptyDir();
  scaffold(ROOT, 'web-app', target, {
    year: 2026,
    tokens: { PROJECT_NAME: 'cli-repo', PROJECT_SUMMARY: 'The right summary.' },
  });
  unlinkSync(join(target, PROVENANCE_FILE));
  execFileSync('git', ['init', target], { stdio: 'ignore' });
  const enrolled = enrollRepo(ROOT, target, {
    profile: 'web-app',
    tokens: { YEAR: '2026', PROJECT_NAME: 'cli-repo', PROJECT_SUMMARY: 'The wrong one.' },
    write: true,
  });
  return { target, spurious: enrolled.diverged.map(({ rel }) => rel) };
};

test('CLI --accept-all exits 2 with the --add-all message shape', () => {
  const { target } = misenrolled();

  const result = run(ROOT, target, '--profile=web-app', ...RIGHT, '--accept-all');

  assert.equal(result.status, 2);
  assert.match(result.stderr, /no --accept-all/i);
  assert.match(result.stderr, /naming each entry is what makes re-baselining it a decision/i);
});

test('CLI reports without --write, and the printed --accept line is what makes the write work', () => {
  const { target, spurious } = misenrolled();
  const before = readFileSync(join(target, PROVENANCE_FILE), 'utf8');

  const report = run(ROOT, target, '--profile=web-app', ...RIGHT);
  assert.equal(report.status, 0);
  assert.match(report.stdout, /dry run: nothing was written/);
  assert.equal(readFileSync(join(target, PROVENANCE_FILE), 'utf8'), before);

  // Copied out of the report, exactly as an operator would paste it.
  const pasted = report.stdout.match(/--accept=\S+/g);
  assert.equal(pasted.length >= spurious.length, true);

  const applied = run(ROOT, target, '--profile=web-app', ...RIGHT, ...pasted, '--write');
  assert.equal(applied.status, 0);
  assert.match(applied.stdout, /wrote \.daftplate\.json/);
  for (const rel of spurious) {
    assert.equal(readProvenance(target).files[rel].ownership, 'managed');
  }
});

test('CLI refuses a target with no manifest, on stderr, with exit 1', () => {
  const target = emptyDir();
  scaffold(ROOT, 'web-app', target, {
    year: 2026, tokens: { PROJECT_NAME: 'cli-repo', PROJECT_SUMMARY: 'x' },
  });
  unlinkSync(join(target, PROVENANCE_FILE));

  const result = run(ROOT, target, '--profile=web-app', ...RIGHT);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /has no \.daftplate\.json/);
  assert.match(result.stderr, /enroll/);
  assert.equal(result.stdout, '');
});
