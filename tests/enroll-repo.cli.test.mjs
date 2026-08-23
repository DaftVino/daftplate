import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDir } from './helpers/make-repo.mjs';
import { scaffold } from '../scripts/scaffold.mjs';
import { PROVENANCE_FILE, MAX_PROVENANCE_SCHEMA, readProvenance } from '../scripts/lib/provenance.mjs';

// The command, exercised the way an operator runs it. An injected main() proves
// the argv-to-engine mapping and nothing about the thing that gets typed: not
// that runCli fires, not that the exit code reaches the shell, not that refusals
// go to stderr rather than stdout. A subprocess cannot be injected into.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/enroll-repo.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

const enrollable = () => {
  const target = emptyDir();
  scaffold(ROOT, 'web-app', target, {
    year: 2026,
    tokens: { PROJECT_NAME: 'cli-fixture', PROJECT_SUMMARY: 'CLI fixture.' },
  });
  unlinkSync(join(target, PROVENANCE_FILE));
  execFileSync('git', ['init', target], { stdio: 'ignore' });
  return target;
};

// PROJECT_SUMMARY carries a space on purpose: it reaches the child as one argv
// entry through spawnSync, and any shell in the path would split it.
const inputs = (target) => [
  ROOT, target, '--profile=web-app', '--token=YEAR=2026',
  '--token=PROJECT_NAME=cli-fixture', '--token=PROJECT_SUMMARY=CLI fixture.',
];

test('CLI exits 2 and explains itself with no arguments', () => {
  const result = run();

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /usage: node scripts\/enroll-repo\.mjs/);
});

test('CLI dry-runs by default and writes nothing', () => {
  const target = enrollable();
  const result = run(...inputs(target));

  assert.equal(result.status, 0);
  assert.match(result.stdout, /dry run/i);
  assert.equal(existsSync(join(target, PROVENANCE_FILE)), false);
});

test('CLI --write creates the manifest and says so on stdout', () => {
  const target = enrollable();
  const result = run(...inputs(target), '--write');

  assert.equal(result.status, 0);
  assert.match(result.stdout, /wrote/i);
  assert.equal(readProvenance(target).schema, MAX_PROVENANCE_SCHEMA);
});

test('CLI --json emits parseable JSON on stdout and nothing else', () => {
  const target = enrollable();
  const result = run(...inputs(target), '--json');

  assert.equal(result.status, 0);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.equal(JSON.parse(result.stdout).profile, 'web-app');
});

test('CLI refusals exit nonzero and report on stderr, not stdout', () => {
  const target = enrollable();
  const result = run(...inputs(target).filter((a) => !a.startsWith('--profile')));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /profile/i);
  assert.equal(result.stdout, '');
});
