import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo } from './helpers/make-repo.mjs';

const SCRIPT = fileURLToPath(new URL('../profiles/design-vault/files/scripts/validate-vault.mjs', import.meta.url));
const run = (args = [], opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...opts });

const CLEAN = { 'docs/10-world/harbour.md': '---\ntitle: Harbour\nupdated: 2026-07-22\n---\n\nThe harbour.\n' };

test('CLI exits 0 and prints clean on a well-formed vault', () => {
  const result = run([makeRepo(CLEAN)]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /clean/);
});

test('CLI exits 1 and names the violated rule on an unknown bucket', () => {
  const result = run([makeRepo({ 'docs/scratch/idea.md': '# i\n' })]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /bucket: docs\/scratch/);
});

test('CLI defaults the vault root to the working directory when given no argument', () => {
  const result = run([], { cwd: makeRepo(CLEAN) });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /clean/);
});

test('the import.meta.url guard runs main when the file is executed directly', () => {
  // Only main prints the "N violation(s)" summary; seeing it proves the guard
  // fired and executed main rather than the file merely being importable.
  const result = run([makeRepo({ 'docs/scratch/idea.md': '# i\n' })]);

  assert.match(result.stdout, /violation\(s\)/);
});
